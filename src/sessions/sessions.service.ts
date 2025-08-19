import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { Session } from './schemas/session.schema';
import { Action } from './schemas/action.schema';
import { RequestEvt } from './schemas/request.schema';
import { DbChange } from './schemas/db-change.schema';
import { RrwebChunk } from './schemas/rrweb-chunk.schema';

@Injectable()
export class SessionsService {
    constructor(
        @InjectModel(Session.name) private sessions: Model<Session>,
        @InjectModel(Action.name) private actions: Model<Action>,
        @InjectModel(RequestEvt.name) private requests: Model<RequestEvt>,
        @InjectModel(DbChange.name) private changes: Model<DbChange>,
        @InjectModel(RrwebChunk.name) private chunks: Model<RrwebChunk>,
    ) {}

    async startSession(appId: string, clientTime?: number) {
        const sessionId = 'S_' + randomUUID();
        await this.sessions.create({ _id: sessionId, appId, startedAt: new Date(clientTime ?? Date.now()) });
        return { sessionId, clockOffsetMs: 0 };
    }

    async appendEvents(sessionId: string, body: any) {
        for (const ev of body.events ?? []) {
            if (ev.type === 'rrweb') {
                await this.chunks.create({
                    sessionId,
                    seq: body.seq ?? ev.t,
                    tFirst: ev.t,
                    tLast: ev.t,
                    data: Buffer.from(ev.chunk ?? ''),
                });
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
        for (const e of body.entries ?? []) {
            if (e.request) {
                await this.requests.create({
                    sessionId, actionId: e.actionId, rid: e.request.rid,
                    method: e.request.method, url: e.request.path || e.request.url,
                    status: e.request.status, durMs: e.request.durMs, t: e.t, headers: e.request.headers ?? {},
                });
            }
            for (const d of e.db ?? []) {
                await this.changes.create({
                    sessionId, actionId: e.actionId, collection: d.collection, pk: d.pk,
                    before: d.before ?? null, after: d.after ?? null, op: d.op ?? 'update', t: e.t,
                });
            }
        }
        return { ok: true };
    }

    async finishSession(sessionId: string, notes?: string) {
        await this.sessions.updateOne({ _id: sessionId }, { $set: { finishedAt: new Date(), notes: notes ?? '' } });
        return { viewerUrl: `${process.env.APP_URL ?? 'https://repro.app'}/s/${sessionId}` };
    }
}
