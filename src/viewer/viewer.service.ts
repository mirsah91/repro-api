import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session } from '../sessions/schemas/session.schema';
import { Action } from '../sessions/schemas/action.schema';
import { RequestEvt } from '../sessions/schemas/request.schema';
import { DbChange } from '../sessions/schemas/db-change.schema';
import { RrwebChunk } from '../sessions/schemas/rrweb-chunk.schema';
import { FullResponseDto } from './viewer.dto';
import { EmailEvt } from '../sessions/schemas/emails.schema';
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
    private readonly tenant: TenantContext,
  ) {}

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

  async full(
    sessionId: string,
    opts?: {
      appId?: string;
      includeRrweb?: boolean;
      includeRespDiffs?: boolean;
    },
  ): Promise<FullResponseDto> {
    const appId = opts?.appId;
    if (!appId) throw new NotFoundException('Session not found');
    const s = await this.sessions
      .findOne(this.tenantFilter({ _id: sessionId, appId }))
      .lean();
    if (!s) throw new NotFoundException('Session not found');

    const [acts, reqDocs, dbDocs, mailDocs] = await Promise.all([
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
    ]);
    const reqs = reqDocs.map((doc) => hydrateRequestDoc(doc));
    const dbs = dbDocs.map((doc) => hydrateChangeDoc(doc));
    const mails = mailDocs.map((doc) => hydrateEmailDoc(doc));

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
