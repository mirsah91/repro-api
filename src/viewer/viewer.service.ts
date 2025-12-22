import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session } from '../sessions/schemas/session.schema';
import { Action } from '../sessions/schemas/action.schema';
import { RequestEvt } from '../sessions/schemas/request.schema';
import { DbChange } from '../sessions/schemas/db-change.schema';
import { RrwebChunk } from '../sessions/schemas/rrweb-chunk.schema';
import {
  FullResponseDto,
  TimelineActionsResponseDto,
} from './viewer.dto';
import { EmailEvt } from '../sessions/schemas/emails.schema';
import { TraceEvt } from '../sessions/schemas/trace.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from '../sessions/utils/session-data-crypto';

@Injectable()
export class ViewerService {
  constructor(
    @InjectModel(Session.name) private sessions: Model<Session>,
    @InjectModel(Action.name) private actions: Model<Action>,
    @InjectModel(RequestEvt.name) private requests: Model<RequestEvt>,
    @InjectModel(DbChange.name) private changes: Model<DbChange>,
    @InjectModel(RrwebChunk.name) private chunks: Model<RrwebChunk>,
    @InjectModel(EmailEvt.name) private readonly emails: Model<EmailEvt>,
    @InjectModel(TraceEvt.name) private readonly traces: Model<TraceEvt>,
    private readonly tenant: TenantContext,
  ) {}

  private normalizeSpanId(val: any): string | null {
    if (val === null || typeof val === 'undefined') {
      return null;
    }
    const str = String(val).trim();
    return str ? str : null;
  }

  private attachDbChangeToTraceData(
    payload: any,
    dbChangeBySpanId: Map<string, any>,
  ): any {
    if (!payload) {
      return payload;
    }

    if (Array.isArray(payload)) {
      let changed = false;
      const out = payload.map((event) => {
        if (!event || typeof event !== 'object') {
          return event;
        }
        const spanKey = this.normalizeSpanId((event as any).spanId);
        if (!spanKey) {
          return event;
        }
        const dbChange = dbChangeBySpanId.get(spanKey);
        if (!dbChange) {
          return event;
        }
        if (Object.prototype.hasOwnProperty.call(event, 'dbChange')) {
          return event;
        }
        changed = true;
        return { ...event, dbChange };
      });
      return changed ? out : payload;
    }

    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (!trimmed) {
        return payload;
      }
      try {
        const parsed = JSON.parse(trimmed);
        return this.attachDbChangeToTraceData(parsed, dbChangeBySpanId);
      } catch {
        return payload;
      }
    }

    if (typeof payload === 'object') {
      if (Object.prototype.hasOwnProperty.call(payload, 'events')) {
        const events = (payload as any).events;
        const enrichedEvents = this.attachDbChangeToTraceData(
          events,
          dbChangeBySpanId,
        );
        if (enrichedEvents === events) {
          return payload;
        }
        return { ...payload, events: enrichedEvents };
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
        const data = (payload as any).data;
        const enrichedData = this.attachDbChangeToTraceData(
          data,
          dbChangeBySpanId,
        );
        if (enrichedData === data) {
          return payload;
        }
        return { ...payload, data: enrichedData };
      }
    }

    return payload;
  }

  /** ---- tiny JSON diff helper (MVP) ---- */
  private isObjectLike(v: any) {
    return v !== null && typeof v === 'object';
  }

  /** -------- smarter JSON diff (arrays keyed by _id, ignore timestamps) -------- */
  private jsonDiff(
    a: any,
    b: any,
    opts?: { arrayKey?: string; ignore?: string[] },
  ) {
    const ignore = new Set([
      ...(opts?.ignore ?? []),
      'createdAt',
      'updatedAt',
      '__v',
    ]);
    const changes: Array<{
      path: string;
      type: 'added' | 'removed' | 'changed';
      from?: any;
      to?: any;
    }> = [];
    const self = this;

    walk(a, b, '');

    return {
      hasChanges: changes.length > 0,
      addedCount: changes.filter((c) => c.type === 'added').length,
      removedCount: changes.filter((c) => c.type === 'removed').length,
      changedCount: changes.filter((c) => c.type === 'changed').length,
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
          else if (i >= y.length)
            changes.push({ path: p, type: 'removed', from: x[i] });
          else walk(x[i], y[i], p);
        }
        return;
      }

      // Objects: recurse by keys (skip ignored)
      if (xObj && yObj) {
        const keys = new Set<string>([
          ...Object.keys(x || {}),
          ...Object.keys(y || {}),
        ]);
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

    function isObjLike(v: any) {
      return v !== null && typeof v === 'object';
    }
    function detectArrayKey(a1: any[], a2: any[], prefer?: string) {
      const cand = prefer ?? '_id';
      const score = (arr: any[]) =>
        arr.filter((o) => o && typeof o === 'object' && cand in o).length;
      const total = a1.length + a2.length || 1;
      return (score(a1) + score(a2)) / total >= 0.6 ? cand : null; // 60% have the key => keyable
    }
    function toMap(arr: any[], key: string) {
      const m = new Map<string, any>();
      for (const o of arr)
        if (o && typeof o === 'object' && key in o) m.set(String(o[key]), o);
      return m;
    }
  }

  async summary(sessionId: string, appId: string) {
    const s = await this.sessions
      .findOne(this.tenantFilter({ _id: sessionId, appId }))
      .lean();
    if (!s) throw new NotFoundException('Session not found');
    const actions = await this.actions
      .find(this.tenantFilter({ sessionId }))
      .sort({ tStart: 1 })
      .lean();
    return { sessionId, appId: s?.appId, actions, env: s?.env ?? {} };
  }

  async actionDetails(sessionId: string, actionId: string, appId: string) {
    await this.ensureSession(sessionId, appId);
    const a = await this.actions
      .findOne(this.tenantFilter({ sessionId, actionId }))
      .lean();
    const reqDocs = await this.requests
      .find(this.tenantFilter({ sessionId, actionId }))
      .sort({ t: 1 })
      .lean();
    const dbDocs = await this.changes
      .find(this.tenantFilter({ sessionId, actionId }))
      .sort({ t: 1 })
      .lean();
    const requests = reqDocs.map((doc) => hydrateRequestDoc(doc));
    const db = dbDocs.map((doc) => hydrateChangeDoc(doc));
    return { ui: a?.ui ?? {}, requests, db };
  }

  async timelineActions(
    sessionId: string,
    appId: string,
  ): Promise<TimelineActionsResponseDto> {
    await this.ensureSession(sessionId, appId);

    const [actions, requestsRaw, changesRaw, tracesRaw] = await Promise.all([
      this.actions
        .find(this.tenantFilter({ sessionId }))
        .sort({ tStart: 1 })
        .lean()
        .exec(),
      this.requests
        .find(this.tenantFilter({ sessionId }))
        .sort({ t: 1 })
        .lean()
        .exec(),
      this.changes
        .find(this.tenantFilter({ sessionId }))
        .sort({ t: 1 })
        .lean()
        .exec(),
      this.traces
        .find(this.tenantFilter({ sessionId }))
        .sort({ batchIndex: 1 })
        .lean()
        .exec(),
    ]);

    const changeByAction = new Map<string, any[]>();
    const dbChangeBySpanId = new Map<string, any>();
    changesRaw.forEach((change) => {
      const hydrated = this.sanitizeDoc(hydrateChangeDoc(change));
      const key = change.actionId ?? '';
      const list = changeByAction.get(key) ?? [];
      list.push(hydrated);
      changeByAction.set(key, list);

      const spanKey = this.normalizeSpanId(hydrated?.spanContext?.spanId);
      if (spanKey && !dbChangeBySpanId.has(spanKey)) {
        dbChangeBySpanId.set(spanKey, hydrated);
      }
    });

    const traceByRequest = new Map<string, any[]>();
    tracesRaw.forEach((trace) => {
      const cleaned = this.sanitizeDoc(trace);
      cleaned.data = this.attachDbChangeToTraceData(
        cleaned.data,
        dbChangeBySpanId,
      );
      const rid = trace.requestRid ?? '';
      const list = traceByRequest.get(rid) ?? [];
      list.push(cleaned);
      traceByRequest.set(rid, list);
    });
    traceByRequest.forEach((list) =>
      list.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0)),
    );

    const actionPayloads = actions.map((action) => {
      const cleaned = this.sanitizeDoc(action);
      return {
        ...cleaned,
        actionId: cleaned.actionId ?? null,
        label: cleaned.label ?? null,
        tStart: typeof cleaned.tStart === 'number' ? cleaned.tStart : null,
        tEnd: typeof cleaned.tEnd === 'number' ? cleaned.tEnd : null,
        hasReq: typeof cleaned.hasReq === 'boolean' ? cleaned.hasReq : false,
        hasDb: typeof cleaned.hasDb === 'boolean' ? cleaned.hasDb : false,
        error: typeof cleaned.error === 'boolean' ? cleaned.error : false,
        requests: [] as any[],
        dbChanges: changeByAction.get(action.actionId ?? '') ?? [],
      };
    });

    const actionByKey = new Map<string, any>();
    actionPayloads.forEach((a) =>
      actionByKey.set(a.actionId ?? '', a),
    );

    const fallbackActions = new Map<string, any>();
    const ensureAction = (actionId?: string | null) => {
      const key = actionId ?? '';
      const existing = actionByKey.get(key);
      if (existing) return existing;
      const fallback = fallbackActions.get(key);
      if (fallback) return fallback;
      const placeholder = {
        id: `missing:${key || 'unknown'}`,
        actionId: actionId ?? null,
        label: actionId ?? 'Unassigned action',
        tStart: null,
        tEnd: null,
        hasReq: null,
        hasDb: null,
        error: null,
        ui: {},
        requests: [] as any[],
        dbChanges: changeByAction.get(key) ?? [],
      };
      fallbackActions.set(key, placeholder);
      return placeholder;
    };

    requestsRaw.forEach((req) => {
      const hydrated = hydrateRequestDoc(req);
      const cleaned = this.sanitizeDoc(hydrated);
      cleaned.actionId = cleaned.actionId ?? null;
      cleaned.url = cleaned.url ?? cleaned.path ?? null;
      cleaned.path = typeof cleaned.path === 'string' ? cleaned.path : undefined;
      cleaned.traces = traceByRequest.get(req.rid) ?? [];
      cleaned.dbChanges = changeByAction.get(req.actionId ?? '') ?? [];
      const action = ensureAction(req.actionId ?? '');
      action.requests.push(cleaned);
    });

    fallbackActions.forEach((a) => actionPayloads.push(a));
    actionPayloads.sort(
      (a, b) => (a.tStart ?? Number.MAX_SAFE_INTEGER) - (b.tStart ?? Number.MAX_SAFE_INTEGER),
    );

    return { sessionId, actions: actionPayloads };
  }

  async full(
    sessionId: string,
    opts?: {
      appId?: string;
      includeRrweb?: boolean;
      includeRespDiffs?: boolean;
      includeTraces?: boolean;
    },
  ): Promise<FullResponseDto> {
    const appId = opts?.appId;
    if (!appId) throw new NotFoundException('Session not found');
    const s = await this.sessions
      .findOne(this.tenantFilter({ _id: sessionId, appId }))
      .lean();
    if (!s) throw new NotFoundException('Session not found');

    const [acts, reqDocs, dbDocs, mailDocs, traceDocs] = await Promise.all([
      this.actions
        .find(this.tenantFilter({ sessionId }))
        .sort({ tStart: 1 })
        .lean(),
      this.requests
        .find(this.tenantFilter({ sessionId }))
        .sort({ t: 1 })
        .lean(),
      this.changes.find(this.tenantFilter({ sessionId })).sort({ t: 1 }).lean(),
      this.emails.find(this.tenantFilter({ sessionId })).sort({ t: 1 }).lean(), // <-- new
      opts?.includeTraces
        ? this.traces
            .find(this.tenantFilter({ sessionId }))
            .sort({ requestRid: 1, batchIndex: 1 })
            .lean()
        : Promise.resolve([]),
    ]);
    const reqs = reqDocs.map((doc) => hydrateRequestDoc(doc));
    const dbs = dbDocs.map((doc) => hydrateChangeDoc(doc));
    const mails = mailDocs.map((doc) => hydrateEmailDoc(doc));

    if (opts?.includeTraces) {
      const dbChangeBySpanId = new Map<string, any>();
      for (const change of dbs) {
        const spanKey = this.normalizeSpanId(change?.spanContext?.spanId);
        if (!spanKey) continue;
        if (!dbChangeBySpanId.has(spanKey)) {
          dbChangeBySpanId.set(spanKey, change);
        }
      }

      const tracesByRid: Record<string, any[]> = {};
      for (const trace of traceDocs ?? []) {
        const rid = trace?.requestRid;
        if (!rid) continue;

        const enriched = {
          ...trace,
          data: this.attachDbChangeToTraceData(trace.data, dbChangeBySpanId),
        };
        (tracesByRid[rid] ||= []).push(enriched);
      }
      Object.values(tracesByRid).forEach((list) =>
        list.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0)),
      );

      for (const req of reqs) {
        (req as any).traces = tracesByRid[req.rid] ?? [];
      }
    }

    const mailBy: Record<string, any[]> = {};
    for (const m of mails) (mailBy[m.actionId || ''] ||= []).push(m);

    // group by actionId
    const reqBy: Record<string, any[]> = {};
    const dbBy: Record<string, any[]> = {};
    for (const r of reqs) (reqBy[r.actionId] ||= []).push(r);
    for (const d of dbs) (dbBy[d.actionId] ||= []).push(d);

    const actions = acts.map((a) => {
      const sanitizedEmails = (mailBy[a.actionId] || []).map((e) => {
        return {
          ...e,
          // in the Viewer client use atob to decode the html.
          html: Buffer.from(
            this.sanitizeEmailHtml(e?.html) || '',
            'utf8',
          ).toString('base64'),
        };
      });

      return {
        actionId: a.actionId ?? null,
        label: a.label ?? null,
        tStart: a.tStart ?? null,
        tEnd: a.tEnd ?? null,
        hasReq: a.hasReq ?? null,
        hasDb: a.hasDb ?? null,
        error: a.error ?? null,
        ui: a.ui ?? {},
        requests: reqBy[a.actionId] || [],
        db: dbBy[a.actionId] || [],
        emails: sanitizedEmails || [], // <-- add to payload
      };
    });

    // optional rrweb meta
    let rrweb: any = undefined;
    if (opts?.includeRrweb) {
      const [first] = await this.chunks
        .find(this.tenantFilter({ sessionId }))
        .sort({ seq: 1 })
        .limit(1)
        .lean();
      const [last] = await this.chunks
        .find(this.tenantFilter({ sessionId }))
        .sort({ seq: -1 })
        .limit(1)
        .lean();
      const count = await this.chunks.countDocuments(
        this.tenantFilter({ sessionId }),
      );
      rrweb = {
        chunks: count,
        firstSeq: first?.seq ?? null,
        lastSeq: last?.seq ?? null,
      };
    }

    // optional response diffs (grouped by normalized key)
    let respDiffs: any = undefined;
    if (opts?.includeRespDiffs) {
      const byKey: Record<string, any[]> = {};
      for (const r of reqs) {
        const key =
          r.key ||
          `${String(r.method || 'GET').toUpperCase()} ${String(r.url || '/').split('?')[0]}`;
        (byKey[key] ||= []).push(r);
      }

      const groups: any[] = [];
      for (const [key, arr] of Object.entries(byKey)) {
        const arrWithBodies = arr.filter(
          (r) => typeof r.respBody !== 'undefined',
        );
        if (arrWithBodies.length < 2) continue;

        const calls = arrWithBodies.map((r) => ({
          rid: r.rid,
          t: r.t,
          status: r.status,
          durMs: r.durMs,
        }));

        const diffs: any[] = [];
        for (let i = 1; i < arrWithBodies.length; i++) {
          const prev = arrWithBodies[i - 1];
          const curr = arrWithBodies[i];
          const d = this.jsonDiff(prev.respBody, curr.respBody);
          if (d.hasChanges) {
            diffs.push({
              fromRid: prev.rid,
              toRid: curr.rid,
              tFrom: prev.t,
              tTo: curr.t,
              summary: {
                added: d.addedCount,
                removed: d.removedCount,
                changed: d.changedCount,
              },
              changes: d.changes, // [{ path, type, from?, to? }]
            });
          }
        }

        if (diffs.length) groups.push({ key, calls, diffs });
      }

      if (groups.length) respDiffs = groups;
    }

    return {
      sessionId,
      appId: s?.appId,
      startedAt: s?.startedAt,
      finishedAt: s?.finishedAt,
      clockOffsetMs:
        typeof s?.clockOffsetMs === 'number' ? s?.clockOffsetMs : undefined,
      rrweb, // only when include=rrweb
      actions, // unchanged
      respDiffs, // only when include=respdiffs
    };
  }

  private sanitizeEmailHtml(raw: string): string {
    if (!raw) return raw;

    let s = raw.replace(/^\uFEFF/, ''); // drop BOM if present

    // 1) Remove one or more leading comment blocks before the doctype
    s = s.replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/m, '');

    // 2) Ensure we start with a doctype
    if (!/^<!DOCTYPE\s+/i.test(s)) {
      s = '<!DOCTYPE html>\n' + s;
    }

    // (Optional) If you still need to be extra strict for XML tools,
    // you could also remove conditional comments or normalize bad comment sequences.
    // But usually removing the top comment is enough.

    return s
      .replace(/[\n\r\t]/gm, '')
      .replace(/<\!--.*?-->/g, '')
      .replace(/\\"/g, '"');
  }

  private sanitizeDoc<T>(doc: T): T {
    if (Array.isArray(doc)) {
      return doc.map((item) => this.sanitizeDoc(item)) as unknown as T;
    }
    if (!doc || typeof doc !== 'object') {
      return doc;
    }
    if (Buffer.isBuffer(doc)) {
      return doc.toString('utf8') as unknown as T;
    }
    if (doc instanceof Date) {
      return doc.toISOString() as unknown as T;
    }
    const cleaned: Record<string, any> = {};
    Object.entries(doc as Record<string, any>).forEach(([key, value]) => {
      if (key === '__v' || key === 'tenantId') {
        return;
      }
      if (key === '_id') {
        cleaned.id = this.normalizeId(value);
        return;
      }
      cleaned[key] = this.sanitizeDoc(value);
    });
    return cleaned as T;
  }

  private normalizeId(val: any): string | undefined {
    if (val === null || typeof val === 'undefined') {
      return undefined;
    }
    if (typeof val === 'string') {
      return val;
    }
    if (typeof val === 'object' && typeof val.toString === 'function') {
      return val.toString();
    }
    return String(val);
  }

  private async ensureSession(sessionId: string, appId: string) {
    const exists = await this.sessions.exists(
      this.tenantFilter({ _id: sessionId, appId }),
    );
    if (!exists) throw new NotFoundException('Session not found');
  }

  private tenantFilter<T extends Record<string, any>>(
    criteria: T,
  ): T & {
    tenantId: string;
  } {
    return { ...criteria, tenantId: this.tenant.tenantId };
  }
}
