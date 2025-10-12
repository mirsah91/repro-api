import {Injectable, NotFoundException} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { Session } from './schemas/session.schema';
import { Action } from './schemas/action.schema';
import { RequestEvt } from './schemas/request.schema';
import { DbChange } from './schemas/db-change.schema';
import { RrwebChunk } from './schemas/rrweb-chunk.schema';
import {EmailEvt} from "./schemas/emails.schema";

@Injectable()
export class SessionsService {
    constructor(
        @InjectModel(Session.name) private sessions: Model<Session>,
        @InjectModel(Action.name) private actions: Model<Action>,
        @InjectModel(RequestEvt.name) private requests: Model<RequestEvt>,
        @InjectModel(DbChange.name) private changes: Model<DbChange>,
        @InjectModel(RrwebChunk.name) private chunks: Model<RrwebChunk>,
        @InjectModel(EmailEvt.name) private readonly emails: Model<EmailEvt>,
    ) {}

    async startSession(appId: string, clientTime?: number) {
        const sessionId = 'S_' + randomUUID();
        const serverNow = Date.now();
        const client = typeof clientTime === 'number' ? clientTime : serverNow;
        const clockOffsetMs = serverNow - client; // client adds this to align

        // was: new Date(client)
        await this.sessions.create({ _id: sessionId, appId, startedAt: new Date(serverNow) });

        return { sessionId, clockOffsetMs };
    }

    async appendEvents(sessionId: string, body: any) {
        if (body?.type === 'rrweb' && Array.isArray(body.events)) {
            const seq    = Number(body.seq ?? 0);
            const tFirst = Number(body.tFirst ?? Date.now());
            const tLast  = Number(body.tLast ?? tFirst);
            const payload = JSON.stringify(body.events);

            await this.chunks.create({
                sessionId,
                seq,
                tFirst,
                tLast,
                data: Buffer.from(payload, 'utf8'),
            });

            return { ok: true }; // done; nothing else to process in this POST
        }

        for (const ev of body.events ?? []) {
            if (ev.type === 'rrweb') {
                await this.chunks.create({
                    sessionId,
                    seq: body.seq ?? ev.t,
                    tFirst: ev.t,
                    tLast: ev.t,
                    data: Buffer.from(
                        typeof ev.chunk === 'string' ? ev.chunk : JSON.stringify(ev),
                        'utf8'
                    ),
                });
                continue;
            } else if (ev.type === 'action') {
                // Use $setOnInsert ONLY for fields that never appear in $set
                const setOnInsert: any = {
                    sessionId,
                    actionId: ev.aid,
                    tStart: ev.tStart ?? Date.now(),
                    ui: ev.ui ?? {},
                    // no label/hasReq/hasDb/error/tEnd here → avoid conflicts
                };

                // Put mutable/flag fields in $set (conditionally)
                const set: any = {};
                if (ev.label != null) set.label = ev.label;          // update label only when provided
                if (ev.tEnd != null)  set.tEnd  = ev.tEnd;           // close/extend window
                if (ev.hasReq)        set.hasReq = true;             // set true once
                if (ev.hasDb)         set.hasDb  = true;
                if (ev.error)         set.error  = true;

                await this.actions.updateOne(
                    { sessionId, actionId: ev.aid },
                    { $setOnInsert: setOnInsert, ...(Object.keys(set).length ? { $set: set } : {}) },
                    { upsert: true }
                );
            } else if (ev.type === 'net') {
                await this.requests.updateOne(
                    { sessionId, rid: ev.rid },
                    {
                        $set: {
                            sessionId,
                            actionId: ev.aid ?? null,
                            rid: ev.rid,
                            method: ev.method,
                            url: ev.url,
                            status: ev.status,
                            durMs: ev.durMs,
                            t: ev.t,
                            headers: ev.headers ?? {},
                            key: ev.key ?? null,
                            respBody: ev.respBody ?? undefined, // may be undefined if not JSON
                        },
                    },
                    { upsert: true }
                );
            }
        }
        return { ok: true };
    }

    async ingestBackend(sessionId: string, body: any) {
        const entries = body?.entries ?? [];

        console.log('entries --->', JSON.stringify(entries, null, 2))
        for (const e of entries) {
            try {
                // ---- REQUEST ----
                const req = e.request;
                if (req) {
                    const resp = await this.requests.updateOne(
                        { sessionId, rid: req.rid },
                        {
                            $set: {
                                sessionId,
                                actionId: e.actionId ?? null,
                                rid: String(req.rid),
                                method: req.method,
                                url: req.url || req.path,           // keep original
                                status: req.status,
                                durMs: req.durMs,
                                t: e.t,
                                headers: req.headers ?? {},
                                key: req.key ?? null,
                                respBody: typeof req.respBody === 'undefined' ? undefined : req.respBody,
                                trace: req.trace //typeof req.trace === 'string' ? JSON.parse(req.trace) : null
                            }
                        },
                        { upsert: true }
                    );
                }

                // ---- EMAIL ----
                const mail = e.email;
                if (mail) {
                    const norm = (v: any) => {
                        if (!v) return [];
                        return Array.isArray(v) ? v : [v];
                    };

                    await this.emails.create({
                        sessionId,
                        actionId: e.actionId ?? null,
                        provider: mail.provider || 'sendgrid',
                        kind: mail.kind || 'send',
                        from: mail.from ?? null,
                        to: norm(mail.to),
                        cc: norm(mail.cc),
                        bcc: norm(mail.bcc),
                        subject: mail.subject ?? '',
                        text: mail.text ?? null,
                        html: mail.html ?? null,
                        templateId: mail.templateId ?? null,
                        dynamicTemplateData: mail.dynamicTemplateData ?? null,
                        categories: Array.isArray(mail.categories) ? mail.categories : [],
                        customArgs: mail.customArgs ?? null,
                        attachmentsMeta: Array.isArray(mail.attachmentsMeta) ? mail.attachmentsMeta : [],
                        statusCode: typeof mail.statusCode === 'number' ? mail.statusCode : null,
                        durMs: typeof mail.durMs === 'number' ? mail.durMs : null,
                        headers: mail.headers ?? {},
                        t: e.t,
                    });
                }

                // ---- DB CHANGES ----
                for (const d of e.db ?? []) {
                    await this.changes.create({
                        sessionId,
                        actionId: e.actionId ?? null,
                        collection: d.collection,
                        pk: d.pk,
                        before: d.before ?? null,
                        after: d.after ?? null,
                        op: d.op ?? 'update',
                        t: e.t,
                        // NEW: persist query capture
                        query: d.query ?? undefined,
                        resultMeta: d.resultMeta ?? undefined,
                        durMs: d.durMs ?? undefined,
                        error: d.error ?? undefined,
                    });
                }
            } catch (err) {
                // isolate failures to a single entry
                // optionally log to your logger here
                console.log('error --->', err)
            }
        }
        return { ok: true };
    }

    async finishSession(sessionId: string, notes?: string) {
        await this.sessions.updateOne({ _id: sessionId }, { $set: { finishedAt: new Date(), notes: notes ?? '' } });
        return { viewerUrl: `${process.env.APP_URL ?? 'https://repro.app'}/s/${sessionId}` };
    }

    async getRrwebChunksPaged(sessionId: string, afterSeq: number, limit: number) {
        return this.chunks
            .find({ sessionId, seq: { $gt: afterSeq } })
            .sort({ seq: 1 })
            .limit(limit)
            .lean()
            .exec();
    }

    async getTimeline(sessionId: string) {
        const [actions, requests, db, emails] = await Promise.all([
            this.actions.find({ sessionId }).lean().exec(),
            this.requests.find({ sessionId }).lean().exec(),
            this.changes.find({ sessionId }).lean().exec(),
            this.emails.find({ sessionId }).lean().exec(),
        ]);

        // Flatten everything into “ticks” with a common `t` (ms, server time)
        const ticks: any[] = [];

        for (const a of actions) {
            ticks.push({
                kind: 'action',
                actionId: a.actionId,
                label: a.label,
                tStart: a.tStart,
                tEnd: a.tEnd ?? a.tStart,
            });
        }
        for (const r of requests) {
            ticks.push({
                kind: 'request',
                actionId: r.actionId ?? null,
                t: r.t,
                meta: {
                    key: r.key,
                    method: r.method,
                    url: r.url,
                    status: r.status,
                    durMs: r.durMs,
                },
            });
        }
        for (const d of db) {
            ticks.push({
                kind: 'db',
                actionId: d.actionId ?? null,
                t: d.t,
                meta: {
                    collection: d.collection,
                    op: d.op,
                    query: d.query,
                    resultMeta: d.resultMeta,
                    durMs: d.durMs,
                },
            });
        }
        for (const m of emails) {
            ticks.push({
                kind: 'email',
                actionId: m.actionId ?? null,
                t: m.t,
                meta: {
                    subject: m.subject,
                    to: m.to,
                    statusCode: m.statusCode,
                    durMs: m.durMs,
                },
            });
        }

        ticks.sort((a, b) => (a.t ?? a.tStart) - (b.t ?? b.tStart));
        return { sessionId, ticks };
    }

    async getChunk(sessionId: string, seqStr: string, ) {
        const seq = Number(seqStr);
        if (!Number.isFinite(seq)) throw new NotFoundException('bad seq');

        const doc = await this.chunks.findOne({ sessionId, seq }).lean();
        if (!doc) throw new NotFoundException('chunk not found');

        // data is a Buffer; return base64 for the frontend to decode
        const base64 = (doc as any).data?.toString('base64') || '';
        return { base64, tFirst: doc.tFirst, tLast: doc.tLast, seq: doc.seq };
    }
}
