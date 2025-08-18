import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session } from '../sessions/schemas/session.schema';
import { Action } from '../sessions/schemas/action.schema';
import { RequestEvt } from '../sessions/schemas/request.schema';
import { DbChange } from '../sessions/schemas/db-change.schema';
import {RrwebChunk} from "../sessions/schemas/rrweb-chunk.schema";

@Injectable()
export class ViewerService {
    constructor(
        @InjectModel(Session.name) private sessions: Model<Session>,
        @InjectModel(Action.name) private actions: Model<Action>,
        @InjectModel(RequestEvt.name) private requests: Model<RequestEvt>,
        @InjectModel(DbChange.name) private changes: Model<DbChange>,
        @InjectModel(RrwebChunk.name) private chunks: Model<RrwebChunk>,
    ) {}

    // ...existing summary() and actionDetails()

    async full(sessionId: string, opts?: { includeRrweb?: boolean }) {
        const s = await this.sessions.findById(sessionId).lean();

        const [acts, reqs, dbs] = await Promise.all([
            this.actions.find({ sessionId }).sort({ tStart: 1 }).lean(),
            this.requests.find({ sessionId }).sort({ t: 1 }).lean(),
            this.changes.find({ sessionId }).sort({ t: 1 }).lean(),
        ]);

        // group by actionId
        const reqBy: Record<string, any[]> = {};
        const dbBy: Record<string, any[]> = {};
        for (const r of reqs) (reqBy[r.actionId] ||= []).push(r);
        for (const d of dbs) (dbBy[d.actionId] ||= []).push(d);

        const actions = acts.map(a => ({
            actionId: a.actionId,
            label: a.label,
            tStart: a.tStart,
            tEnd: a.tEnd,
            hasReq: a.hasReq,
            hasDb: a.hasDb,
            error: a.error,
            ui: a.ui ?? {},
            requests: reqBy[a.actionId] || [],
            db: dbBy[a.actionId] || [],
        }));

        let rrweb: any = undefined;
        if (opts?.includeRrweb) {
            const [first] = await this.chunks.find({ sessionId }).sort({ seq: 1 }).limit(1).lean();
            const [last]  = await this.chunks.find({ sessionId }).sort({ seq: -1 }).limit(1).lean();
            const count   = await this.chunks.countDocuments({ sessionId });
            rrweb = { chunks: count, firstSeq: first?.seq ?? null, lastSeq: last?.seq ?? null };
        }

        return {
            sessionId,
            appId: s?.appId,
            startedAt: s?.startedAt,
            finishedAt: s?.finishedAt,
            rrweb,           // only present if include=rrweb
            actions,
        };
    }

    async summary(sessionId: string) {
        const s = await this.sessions.findById(sessionId).lean();
        const actions = await this.actions.find({ sessionId }).sort({ tStart: 1 }).lean();
        return { sessionId, appId: s?.appId, actions, env: s?.env ?? {} };
    }

    async actionDetails(sessionId: string, actionId: string) {
        const a = await this.actions.findOne({ sessionId, actionId }).lean();
        const reqs = await this.requests.find({ sessionId, actionId }).sort({ t: 1 }).lean();
        const db = await this.changes.find({ sessionId, actionId }).sort({ t: 1 }).lean();
        return { ui: a?.ui ?? {}, requests: reqs, db };
    }
}
