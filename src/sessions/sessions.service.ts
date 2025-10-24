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
import { TraceEvt } from './schemas/trace.schema';

@Injectable()
export class SessionsService {
    constructor(
        @InjectModel(Session.name) private sessions: Model<Session>,
        @InjectModel(Action.name) private actions: Model<Action>,
        @InjectModel(RequestEvt.name) private requests: Model<RequestEvt>,
        @InjectModel(DbChange.name) private changes: Model<DbChange>,
        @InjectModel(RrwebChunk.name) private chunks: Model<RrwebChunk>,
        @InjectModel(EmailEvt.name) private readonly emails: Model<EmailEvt>,
        @InjectModel(TraceEvt.name) private readonly traces: Model<TraceEvt>,
    ) {}

    private ensureTraceIndexPromise?: Promise<void>;

    private ensureTraceBatchIndex(): Promise<void> {
        if (!this.ensureTraceIndexPromise) {
            this.ensureTraceIndexPromise = (async () => {
                const legacyIndexName = 'sessionId_1_requestRid_1';
                try {
                    await this.traces.collection.dropIndex(legacyIndexName);
                } catch (dropErr: any) {
                    if (dropErr?.codeName !== 'IndexNotFound') {
                        // rethrow unexpected drop failures to avoid masking them
                        throw dropErr;
                    }
                }

                try {
                    await this.traces.collection.createIndex(
                        { sessionId: 1, requestRid: 1, batchIndex: 1 },
                        {
                            unique: true,
                            background: true,
                            name: 'sessionId_1_requestRid_1_batchIndex_1',
                        }
                    );
                } catch (createErr: any) {
                    if (createErr?.codeName !== 'IndexOptionsConflict') {
                        throw createErr;
                    }
                }
            })().catch(err => {
                this.ensureTraceIndexPromise = undefined;
                throw err;
            });
        }

        return this.ensureTraceIndexPromise;
    }

    async startSession(appId: string, clientTime?: number, appUser?: any) {
        const sessionId = 'S_' + randomUUID();
        const serverNow = Date.now();
        const client = typeof clientTime === 'number' ? clientTime : serverNow;
        const clockOffsetMs = serverNow - client; // client adds this to align

        // was: new Date(client)
        const userId = appUser
            ? typeof appUser.id === 'string'
                ? appUser.id
                : appUser._id?.toHexString?.() ?? appUser._id?.toString?.() ?? undefined
            : undefined;

        await this.sessions.create({
            _id: sessionId,
            appId,
            startedAt: new Date(serverNow),
            userId,
            userEmail: appUser?.email,
        });

        return { sessionId, clockOffsetMs };
    }

    async appendEvents(sessionId: string, appId: string, body: any) {
        await this.ensureSessionExists(sessionId, appId);
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

    async ingestBackend(sessionId: string, appId: string, body: any) {
        await this.ensureSessionExists(sessionId, appId);
        const entries = Array.isArray(body?.entries) ? body.entries : [];

        for (const e of entries) {
            try {
                const req = e.request;

                const ridCandidates = [
                    req?.rid,
                    req?.requestRid,
                    req?.requestId,
                    e?.requestRid,
                    e?.rid,
                    e?.traceBatch?.rid,
                ];

                let resolvedRid: string | null = null;
                for (const candidate of ridCandidates) {
                    if (candidate === undefined || candidate === null) {
                        continue;
                    }

                    const asString = String(candidate).trim();
                    if (asString.length) {
                        resolvedRid = asString;
                        break;
                    }
                }

                // ---- REQUEST ----
                if (req && resolvedRid) {
                    const set: Record<string, any> = {
                        sessionId,
                        rid: resolvedRid,
                    };

                    if (typeof e.actionId !== 'undefined') {
                        set.actionId = e.actionId ?? null;
                    }

                    if (typeof e.t === 'number') {
                        set.t = e.t;
                    }

                    if (typeof req.method !== 'undefined') {
                        set.method = req.method;
                    }

                    const urlCandidate = typeof req.url !== 'undefined' ? req.url : req.path;
                    if (typeof urlCandidate !== 'undefined') {
                        set.url = urlCandidate;
                    }

                    if (typeof req.status === 'number') {
                        set.status = req.status;
                    }

                    if (typeof req.durMs === 'number') {
                        set.durMs = req.durMs;
                    }

                    if (typeof req.headers !== 'undefined') {
                        set.headers = req.headers ?? {};
                    }

                    if (Object.prototype.hasOwnProperty.call(req, 'key')) {
                        set.key = req.key ?? null;
                    }

                    if (Object.prototype.hasOwnProperty.call(req, 'respBody')) {
                        set.respBody = req.respBody;
                    }

                    const requestDoc = await this.requests.findOneAndUpdate(
                        { sessionId, rid: resolvedRid },
                        { $set: set },
                        { upsert: true, new: true, setDefaultsOnInsert: true }
                    );

                    if (requestDoc?._id) {
                        await this.traces.updateMany(
                            {
                                sessionId,
                                requestRid: resolvedRid,
                                $or: [
                                    { request: { $exists: false } },
                                    { request: null },
                                ],
                            },
                            { $set: { request: requestDoc._id } }
                        ).exec();
                    }
                }

                // ---- TRACE BATCH ----
                if (e.trace && e.traceBatch) {
                    const batchRid = e.traceBatch?.rid ?? resolvedRid;
                    if (batchRid) {
                        let tracePayload: any = e.trace;
                        if (typeof tracePayload !== 'string') {
                            try {
                                tracePayload = JSON.stringify(tracePayload);
                            } catch {
                                tracePayload = e.trace;
                            }
                        }

                        const indexValue = Number(e.traceBatch.index);
                        const batchIndex = Number.isFinite(indexValue) ? indexValue : 0;
                        const totalValue = Number(e.traceBatch.total);
                        const hasTotal = Number.isFinite(totalValue);

                        const existingRequest = await this.requests
                            .findOne({ sessionId, rid: batchRid }, { _id: 1 })
                            .lean()
                            .exec();

                        const setPayload: Record<string, any> = {
                            sessionId,
                            requestRid: batchRid,
                            batchIndex,
                            data: hasTotal ? { events: tracePayload, total: totalValue } : tracePayload,
                        };

                        if (existingRequest?._id) {
                            setPayload.request = existingRequest._id;
                        }

                        try {
                            await this.traces
                                .updateOne(
                                    { sessionId, requestRid: batchRid, batchIndex },
                                    { $set: setPayload },
                                    { upsert: true }
                                )
                                .exec();
                        } catch (err: any) {
                            if (
                                err?.code === 11000 &&
                                err?.keyPattern?.sessionId === 1 &&
                                err?.keyPattern?.requestRid === 1
                            ) {
                                await this.ensureTraceBatchIndex();

                                await this.traces
                                    .updateOne(
                                        { sessionId, requestRid: batchRid, batchIndex },
                                        { $set: setPayload },
                                        { upsert: true }
                                    )
                                    .exec();
                            } else {
                                throw err;
                            }
                        }
                    }
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

    async finishSession(sessionId: string, appId: string, notes?: string) {
        const res = await this.sessions.findOneAndUpdate(
            { _id: sessionId, appId },
            { $set: { finishedAt: new Date(), notes: notes ?? '' } },
        );
        if (!res) throw new NotFoundException('Session not found');
        return { viewerUrl: `${process.env.APP_URL ?? 'https://repro.app'}/s/${sessionId}` };
    }

    async getRrwebChunksPaged(sessionId: string, appId: string, afterSeq: number, limit: number) {
        await this.ensureSessionExists(sessionId, appId);
        return this.chunks
            .find({ sessionId, seq: { $gt: afterSeq } })
            .sort({ seq: 1 })
            .limit(limit)
            .lean()
            .exec();
    }

    async getTimeline(sessionId: string, appId: string) {
        await this.ensureSessionExists(sessionId, appId);
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

    async getTracesBySession(sessionId: string, appId: string) {
        await this.ensureSessionExists(sessionId, appId);
        const NULL_KEY = '__trace_null_key__';
        const traceDocs = await this.traces
            .find({ sessionId })
            .sort({ requestRid: 1, batchIndex: 1 })
            .populate({ path: 'request', select: 'key durMs status' })
            .lean()
            .exec();

        const grouped = new Map<string, { key: string | null; traces: Map<string, { requestRid: string; request: any; batches: Array<{ traceId: string; batchIndex: number; trace: any }> }> }>();

        for (const trace of traceDocs) {
            const request = (trace as any).request as any | undefined;
            const key = request?.key ?? null;
            const mapKey = key ?? NULL_KEY;

            if (!grouped.has(mapKey)) {
                grouped.set(mapKey, { key, traces: new Map() });
            }

            const group = grouped.get(mapKey)!;
            const requestKey = trace.requestRid;

            if (!group.traces.has(requestKey)) {
                group.traces.set(requestKey, {
                    requestRid: trace.requestRid,
                    request: request
                        ? {
                            key: request.key ?? null,
                            durMs: request.durMs ?? null,
                            status: request.status ?? null,
                        }
                        : null,
                    batches: [],
                });
            }

            group.traces.get(requestKey)!.batches.push({
                traceId: String(trace._id),
                batchIndex: Number(trace.batchIndex ?? 0),
                trace: trace.data ?? null,
            });
        }

        return {
            sessionId,
            items: Array.from(grouped.values()).map(group => ({
                key: group.key,
                traces: Array.from(group.traces.values()).map(entry => ({
                    ...entry,
                    batches: entry.batches.sort((a, b) => a.batchIndex - b.batchIndex),
                })),
            })),
        };
    }

    async getChunk(sessionId: string, appId: string, seqStr: string) {
        await this.ensureSessionExists(sessionId, appId);
        const seq = Number(seqStr);
        if (!Number.isFinite(seq)) throw new NotFoundException('bad seq');

        const doc = await this.chunks.findOne({ sessionId, seq }).lean();
        if (!doc) throw new NotFoundException('chunk not found');

        // data is a Buffer; return base64 for the frontend to decode
        const base64 = (doc as any).data?.toString('base64') || '';
        return { base64, tFirst: doc.tFirst, tLast: doc.tLast, seq: doc.seq };
    }

    private async ensureSessionExists(sessionId: string, appId: string) {
        const exists = await this.sessions.exists({ _id: sessionId, appId });
        if (!exists) throw new NotFoundException('Session not found');
    }
}
