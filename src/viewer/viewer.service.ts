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

    async full(
        sessionId: string,
        opts?: { includeRrweb?: boolean; includeRespDiffs?: boolean }
    ) {
        const s = await this.sessions.findById(sessionId).lean();

        const [acts, reqs, dbs] = await Promise.all([
            this.actions.find({ sessionId }).sort({ tStart: 1 }).lean(),
            this.requests.find({ sessionId }).sort({ t: 1 }).lean(), // sorted -> groups keep order
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

        // optional rrweb meta
        let rrweb: any = undefined;
        if (opts?.includeRrweb) {
            const [first] = await this.chunks.find({ sessionId }).sort({ seq: 1 }).limit(1).lean();
            const [last]  = await this.chunks.find({ sessionId }).sort({ seq: -1 }).limit(1).lean();
            const count   = await this.chunks.countDocuments({ sessionId });
            rrweb = { chunks: count, firstSeq: first?.seq ?? null, lastSeq: last?.seq ?? null };
        }

        // optional response diffs (grouped by normalized key)
        let respDiffs: any = undefined;
        if (opts?.includeRespDiffs) {
            console.log('includeRespDiffs !!!')
            const byKey: Record<string, any[]> = {};
            for (const r of reqs) {
                const key =
                    r.key ||
                    `${String(r.method || 'GET').toUpperCase()} ${String(r.url || '/').split('?')[0]}`;
                (byKey[key] ||= []).push(r);
            }

            const groups: any[] = [];
            for (const [key, arr] of Object.entries(byKey)) {
                const arrWithBodies = arr.filter(r => typeof (r as any).respBody !== 'undefined');
                if (arrWithBodies.length < 2) continue;

                const calls = arrWithBodies.map(r => ({
                    rid: r.rid,
                    t: r.t,
                    status: r.status,
                    durMs: r.durMs,
                }));

                const diffs: any[] = [];
                for (let i = 1; i < arrWithBodies.length; i++) {
                    const prev = arrWithBodies[i - 1] as any;
                    const curr = arrWithBodies[i] as any;
                    const d = this.jsonDiff(prev.respBody, curr.respBody);
                    if (d.hasChanges) {
                        diffs.push({
                            fromRid: prev.rid,
                            toRid: curr.rid,
                            tFrom: prev.t,
                            tTo: curr.t,
                            summary: { added: d.addedCount, removed: d.removedCount, changed: d.changedCount },
                            changes: d.changes, // [{ path, type, from?, to? }]
                        });
                    }
                }
                console.log('diffs !!!', diffs)

                if (diffs.length) groups.push({ key, calls, diffs });
            }

            console.log('groups !!!', groups)

            if (groups.length) respDiffs = groups;
        }

        return {
            sessionId,
            appId: s?.appId,
            startedAt: s?.startedAt,
            finishedAt: s?.finishedAt,
            rrweb,     // only when include=rrweb
            actions,   // unchanged
            respDiffs, // only when include=respdiffs
        };
    }

    /** ---- tiny JSON diff helper (MVP) ---- */
    private isObjectLike(v: any) {
        return v !== null && typeof v === 'object';
    }

    /** -------- smarter JSON diff (arrays keyed by _id, ignore timestamps) -------- */
    private jsonDiff(
        a: any, b: any,
        opts?: { arrayKey?: string; ignore?: string[] }
    ) {
        const ignore = new Set([...(opts?.ignore ?? []), 'createdAt', 'updatedAt', '__v']);
        const changes: Array<{ path: string; type: 'added'|'removed'|'changed'; from?: any; to?: any }> = [];
        const self = this;

        walk(a, b, '');

        return {
            hasChanges: changes.length > 0,
            addedCount:   changes.filter(c => c.type === 'added').length,
            removedCount: changes.filter(c => c.type === 'removed').length,
            changedCount: changes.filter(c => c.type === 'changed').length,
            changes,
        };

        function walk(x: any, y: any, path: string) {
            if (x === y) return;

            const xObj = isObjLike(x);
            const yObj = isObjLike(y);

            // Arrays: try to treat as sets keyed by _id (or opts.arrayKey)
            if (Array.isArray(x) && Array.isArray(y)) {
                const key = detectArrayKey(x, y, opts?.arrayKey);
                if (key) {
                    const mx = toMap(x, key);
                    const my = toMap(y, key);
                    const ids = new Set<string>([...mx.keys(), ...my.keys()]);

                    for (const id of ids) {
                        const vx = mx.get(id);
                        const vy = my.get(id);
                        const p = path ? `${path}[${id}]` : `[${id}]`;
                        if (vx && !vy) {
                            changes.push({ path: p, type: 'removed', from: vx });
                        } else if (!vx && vy) {
                            changes.push({ path: p, type: 'added', to: vy });
                        } else if (vx && vy) {
                            walk(vx, vy, p); // recurse on object content
                        }
                    }
                    return;
                }
                // fallback to index-by-index compare if not keyable
                const max = Math.max(x.length, y.length);
                for (let i = 0; i < max; i++) {
                    const p = path ? `${path}.${i}` : String(i);
                    if (i >= x.length) changes.push({ path: p, type: 'added', to: y[i] });
                    else if (i >= y.length) changes.push({ path: p, type: 'removed', from: x[i] });
                    else walk(x[i], y[i], p);
                }
                return;
            }

            // Objects: recurse by keys (skip ignored)
            if (xObj && yObj) {
                const keys = new Set<string>([...Object.keys(x || {}), ...Object.keys(y || {})]);
                for (const k of keys) {
                    if (ignore.has(k)) continue;
                    const nx = x?.[k];
                    const ny = y?.[k];
                    const p = path ? `${path}.${k}` : String(k);
                    if (typeof nx === 'undefined' && typeof ny !== 'undefined') {
                        changes.push({ path: p, type: 'added', to: ny });
                    } else if (typeof nx !== 'undefined' && typeof ny === 'undefined') {
                        changes.push({ path: p, type: 'removed', from: nx });
                    } else {
                        walk(nx, ny, p);
                    }
                }
                return;
            }

            // Primitive or type difference
            changes.push({ path: path || '$', type: 'changed', from: x, to: y });
        }

        function isObjLike(v: any) { return v !== null && typeof v === 'object'; }
        function detectArrayKey(a1: any[], a2: any[], prefer?: string) {
            const cand = prefer ?? '_id';
            const score = (arr: any[]) => arr.filter(o => o && typeof o === 'object' && cand in o).length;
            const total = a1.length + a2.length || 1;
            return (score(a1) + score(a2)) / total >= 0.6 ? cand : null; // 60% have the key => keyable
        }
        function toMap(arr: any[], key: string) {
            const m = new Map<string, any>();
            for (const o of arr) if (o && typeof o === 'object' && key in o) m.set(String(o[key]), o);
            return m;
        }
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