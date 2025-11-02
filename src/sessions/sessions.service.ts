import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { Session } from './schemas/session.schema';
import { Action } from './schemas/action.schema';
import { RequestEvt } from './schemas/request.schema';
import { DbChange } from './schemas/db-change.schema';
import { RrwebChunk } from './schemas/rrweb-chunk.schema';
import { EmailEvt } from './schemas/emails.schema';
import { TraceEvt } from './schemas/trace.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  encryptField,
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from './utils/session-data-crypto';

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
    private readonly tenant: TenantContext,
  ) {}

  private ensureTraceIndexPromise?: Promise<void>;

  private ensureTraceBatchIndex(): Promise<void> {
    if (!this.ensureTraceIndexPromise) {
      this.ensureTraceIndexPromise = (async () => {
        const legacyIndexes = [
          'sessionId_1_requestRid_1',
          'sessionId_1_requestRid_1_batchIndex_1',
        ];
        for (const name of legacyIndexes) {
          try {
            await this.traces.collection.dropIndex(name);
          } catch (dropErr: any) {
            if (dropErr?.codeName !== 'IndexNotFound') {
              throw dropErr;
            }
          }
        }

        try {
          await this.traces.collection.createIndex(
            { tenantId: 1, sessionId: 1, requestRid: 1, batchIndex: 1 },
            {
              unique: true,
              background: true,
              name: 'tenantId_1_sessionId_1_requestRid_1_batchIndex_1',
            },
          );
        } catch (createErr: any) {
          if (createErr?.codeName !== 'IndexOptionsConflict') {
            throw createErr;
          }
        }
      })().catch((err) => {
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
        : (appUser._id?.toHexString?.() ??
          appUser._id?.toString?.() ??
          undefined)
      : undefined;

    await this.sessions.create(
      this.tenantDoc({
        _id: sessionId,
        appId,
        startedAt: new Date(serverNow),
        userId,
        userEmail: appUser?.email,
      }),
    );

    return { sessionId, clockOffsetMs };
  }

  async appendEvents(sessionId: string, appId: string, body: any) {
    await this.ensureSessionExists(sessionId, appId);
    if (body?.type === 'rrweb' && Array.isArray(body.events)) {
      const seq = Number(body.seq ?? 0);
      const tFirst = Number(body.tFirst ?? Date.now());
      const tLast = Number(body.tLast ?? tFirst);
      const payload = JSON.stringify(body.events);

      await this.chunks.create(
        this.tenantDoc({
          sessionId,
          seq,
          tFirst,
          tLast,
          data: Buffer.from(payload, 'utf8'),
        }),
      );

      return { ok: true }; // done; nothing else to process in this POST
    }

    for (const ev of body.events ?? []) {
      if (ev.type === 'rrweb') {
        await this.chunks.create(
          this.tenantDoc({
            sessionId,
            seq: body.seq ?? ev.t,
            tFirst: ev.t,
            tLast: ev.t,
            data: Buffer.from(
              typeof ev.chunk === 'string' ? ev.chunk : JSON.stringify(ev),
              'utf8',
            ),
          }),
        );
        continue;
      } else if (ev.type === 'action') {
        // Use $setOnInsert ONLY for fields that never appear in $set
        const setOnInsert: any = {
          tenantId: this.tenant.tenantId,
          sessionId,
          actionId: ev.aid,
          tStart: ev.tStart ?? Date.now(),
          ui: ev.ui ?? {},
          // no label/hasReq/hasDb/error/tEnd here → avoid conflicts
        };

        // Put mutable/flag fields in $set (conditionally)
        const set: any = {};
        if (ev.label != null) set.label = ev.label; // update label only when provided
        if (ev.tEnd != null) set.tEnd = ev.tEnd; // close/extend window
        if (ev.hasReq) set.hasReq = true; // set true once
        if (ev.hasDb) set.hasDb = true;
        if (ev.error) set.error = true;

        await this.actions.updateOne(
          this.tenantFilter({ sessionId, actionId: ev.aid }),
          {
            $setOnInsert: setOnInsert,
            ...(Object.keys(set).length ? { $set: set } : {}),
          },
          { upsert: true },
        );
      } else if (ev.type === 'net') {
        const set: Record<string, any> = {
          tenantId: this.tenant.tenantId,
          sessionId,
          actionId: ev.aid ?? null,
          rid: ev.rid,
          t: ev.t,
        };

        if (typeof ev.method !== 'undefined') set.method = ev.method;
        if (typeof ev.url !== 'undefined')
          set.url = encryptField(ev.url ?? null);
        if (Object.prototype.hasOwnProperty.call(ev, 'status'))
          set.status = ev.status;
        if (Object.prototype.hasOwnProperty.call(ev, 'durMs'))
          set.durMs = ev.durMs;
        if (typeof ev.headers !== 'undefined')
          set.headers = encryptField(ev.headers ?? {});
        if (typeof ev.key !== 'undefined') set.key = ev.key ?? null;
        if (Object.prototype.hasOwnProperty.call(ev, 'respBody')) {
          set.respBody = encryptField(ev.respBody ?? null);
        }

        await this.requests.updateOne(
          this.tenantFilter({ sessionId, rid: ev.rid }),
          { $set: set },
          { upsert: true },
        );
      }
    }
    return { ok: true };
  }

  async ingestBackend(sessionId: string, appId: string, body: any) {
    await this.ensureSessionExists(sessionId, appId);
    const entries = Array.isArray(body?.entries) ? body.entries : [];

    const actionTimeCache = new Map<string, number | null>();
    const actionTimelineCursor = new Map<string, number>();

    const normalizeActionId = (value: any): string | null => {
      if (value === undefined || value === null) return null;
      const str = String(value).trim();
      return str.length ? str : null;
    };

    const getActionBaseTime = async (actionId: string): Promise<number | null> => {
      if (actionTimeCache.has(actionId)) {
        return actionTimeCache.get(actionId)!;
      }

      const doc = await this.actions
        .findOne(this.tenantFilter({ sessionId, actionId }), {
          tStart: 1,
          tEnd: 1,
        })
        .lean()
        .exec();

      const candidates = [doc?.tStart, doc?.tEnd]
        .map((v) => (typeof v === 'number' ? v : Number(v)))
        .filter((v): v is number => Number.isFinite(v));

      const base = candidates.length
        ? candidates.reduce((max, cur) => (cur > max ? cur : max), candidates[0])
        : null;

      actionTimeCache.set(actionId, base);
      return base;
    };

    const alignTimeForAction = async (
      actionId: string | null,
      rawTime: number,
    ): Promise<number> => {
      let ts = Number.isFinite(rawTime) ? rawTime : Date.now();
      if (!actionId) {
        return ts;
      }

      let minAllowed: number | null = null;
      const base = await getActionBaseTime(actionId);
      if (base !== null) {
        minAllowed = base;
      }

      if (actionTimelineCursor.has(actionId)) {
        const last = actionTimelineCursor.get(actionId)!;
        minAllowed = minAllowed === null ? last : Math.max(minAllowed, last);
      }

      if (minAllowed !== null && ts <= minAllowed) {
        ts = minAllowed + 1;
      }

      actionTimelineCursor.set(actionId, ts);
      return ts;
    };

    for (const e of entries) {
      try {
        const req = e.request;

        const normalizedActionId = normalizeActionId(e.actionId);
        const rawTime = Number(e.t);
        const alignedTime = await alignTimeForAction(
          normalizedActionId,
          Number.isFinite(rawTime) ? rawTime : Date.now(),
        );

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
            tenantId: this.tenant.tenantId,
            sessionId,
            rid: resolvedRid,
          };

          if (Object.prototype.hasOwnProperty.call(e, 'actionId')) {
            set.actionId = normalizedActionId ?? null;
          }

          set.t = alignedTime;

          if (typeof req.method !== 'undefined') {
            set.method = req.method;
          }

          const urlCandidate =
            typeof req.url !== 'undefined' ? req.url : req.path;
          if (typeof urlCandidate !== 'undefined') {
            set.url = encryptField(urlCandidate ?? null);
          }

          if (typeof req.status === 'number') {
            set.status = req.status;
          }

          if (typeof req.durMs === 'number') {
            set.durMs = req.durMs;
          }

          if (typeof req.headers !== 'undefined') {
            set.headers = encryptField(req.headers ?? {});
          }

          if (Object.prototype.hasOwnProperty.call(req, 'key')) {
            set.key = req.key ?? null;
          }

          if (Object.prototype.hasOwnProperty.call(req, 'respBody')) {
            set.respBody = encryptField(req.respBody ?? null);
          }

          const requestDoc = await this.requests.findOneAndUpdate(
            this.tenantFilter({ sessionId, rid: resolvedRid }),
            { $set: set },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );

          if (requestDoc?._id) {
            await this.traces
              .updateMany(
                {
                  tenantId: this.tenant.tenantId,
                  sessionId,
                  requestRid: resolvedRid,
                  $or: [{ request: { $exists: false } }, { request: null }],
                },
                { $set: { request: requestDoc._id } },
              )
              .exec();
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
              .findOne(
                this.tenantFilter({ sessionId, rid: batchRid }),
                { _id: 1 },
              )
              .lean()
              .exec();

            const setPayload: Record<string, any> = {
              tenantId: this.tenant.tenantId,
              sessionId,
              requestRid: batchRid,
              batchIndex,
              data: hasTotal
                ? { events: tracePayload, total: totalValue }
                : tracePayload,
            };

            if (existingRequest?._id) {
              setPayload.request = existingRequest._id;
            }

            try {
              await this.traces
                .updateOne(
                  this.tenantFilter({
                    sessionId,
                    requestRid: batchRid,
                    batchIndex,
                  }),
                  { $set: setPayload },
                  { upsert: true },
                )
                .exec();
            } catch (err: any) {
              if (err?.code === 11000) {
                await this.ensureTraceBatchIndex();

                await this.traces
                  .updateOne(
                    this.tenantFilter({
                      sessionId,
                      requestRid: batchRid,
                      batchIndex,
                    }),
                    { $set: setPayload },
                    { upsert: true },
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

          const to = norm(mail.to);
          const cc = norm(mail.cc);
          const bcc = norm(mail.bcc);
          const categories = Array.isArray(mail.categories)
            ? mail.categories
            : [];
          const attachmentsMeta = Array.isArray(mail.attachmentsMeta)
            ? mail.attachmentsMeta
            : [];

          await this.emails.create(
            this.tenantDoc({
              sessionId,
              actionId: normalizedActionId ?? null,
              provider: mail.provider || 'sendgrid',
              kind: mail.kind || 'send',
              from: encryptField(mail.from ?? null),
              to: encryptField(to),
              cc: encryptField(cc),
              bcc: encryptField(bcc),
              subject: encryptField(mail.subject ?? ''),
              text: encryptField(mail.text ?? null),
              html: encryptField(mail.html ?? null),
              templateId: encryptField(mail.templateId ?? null),
              dynamicTemplateData: encryptField(
                mail.dynamicTemplateData ?? null,
              ),
              categories: encryptField(categories),
              customArgs: encryptField(mail.customArgs ?? null),
              attachmentsMeta: encryptField(attachmentsMeta),
              statusCode:
                typeof mail.statusCode === 'number' ? mail.statusCode : null,
              durMs: typeof mail.durMs === 'number' ? mail.durMs : null,
              headers: encryptField(mail.headers ?? {}),
              t: alignedTime,
            }),
          );
        }

        // ---- DB CHANGES ----
        for (const d of e.db ?? []) {
          const changePayload: Record<string, any> = {
            sessionId,
            actionId: normalizedActionId ?? null,
            collection: d.collection,
            op: d.op ?? 'update',
            t: alignedTime,
          };

          if (typeof d.pk !== 'undefined') {
            changePayload.pk = encryptField(d.pk ?? null);
          }

          changePayload.before = encryptField(d.before ?? null);
          changePayload.after = encryptField(d.after ?? null);

          if (typeof d.query !== 'undefined') {
            changePayload.query = encryptField(d.query ?? null);
          }

          if (typeof d.resultMeta !== 'undefined') {
            changePayload.resultMeta = encryptField(d.resultMeta ?? null);
          }

          if (typeof d.durMs !== 'undefined') {
            changePayload.durMs = d.durMs;
          }

          if (typeof d.error !== 'undefined') {
            changePayload.error = encryptField(d.error ?? null);
          }

          await this.changes.create(this.tenantDoc(changePayload));
        }
      } catch (err) {
        // isolate failures to a single entry
        // optionally log to your logger here
        console.log('error --->', err);
      }
    }
    return { ok: true };
  }

  async finishSession(sessionId: string, appId: string, notes?: string) {
    const res = await this.sessions.findOneAndUpdate(
      this.tenantFilter({ _id: sessionId, appId }),
      { $set: { finishedAt: new Date(), notes: notes ?? '' } },
    );
    if (!res) throw new NotFoundException('Session not found');
    return {
      viewerUrl: `${process.env.APP_URL ?? 'https://repro.app'}/s/${sessionId}`,
    };
  }

  async getRrwebChunksPaged(
    sessionId: string,
    appId: string,
    afterSeq: number,
    limit: number,
  ) {
    await this.ensureSessionExists(sessionId, appId);
    return this.chunks
      .find(this.tenantFilter({ sessionId, seq: { $gt: afterSeq } }))
      .sort({ seq: 1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async getTimeline(sessionId: string, appId: string) {
    await this.ensureSessionExists(sessionId, appId);
    const [actions, requestDocs, changeDocs, emailDocs] = await Promise.all([
      this.actions.find(this.tenantFilter({ sessionId })).lean().exec(),
      this.requests.find(this.tenantFilter({ sessionId })).lean().exec(),
      this.changes.find(this.tenantFilter({ sessionId })).lean().exec(),
      this.emails.find(this.tenantFilter({ sessionId })).lean().exec(),
    ]);
    const requests = requestDocs.map((doc) => hydrateRequestDoc(doc));
    const db = changeDocs.map((doc) => hydrateChangeDoc(doc));
    const emails = emailDocs.map((doc) => hydrateEmailDoc(doc));

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
      .find(this.tenantFilter({ sessionId }))
      .sort({ requestRid: 1, batchIndex: 1 })
      .populate({
        path: 'request',
        match: { tenantId: this.tenant.tenantId },
        select: 'key durMs status',
      })
      .lean()
      .exec();

    const grouped = new Map<
      string,
      {
        key: string | null;
        traces: Map<
          string,
          {
            requestRid: string;
            request: any;
            batches: Array<{ traceId: string; batchIndex: number; trace: any }>;
          }
        >;
      }
    >();

    for (const trace of traceDocs) {
      const request = (trace as any).request;
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
      items: Array.from(grouped.values()).map((group) => ({
        key: group.key,
        traces: Array.from(group.traces.values()).map((entry) => ({
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

    const doc = await this.chunks
      .findOne(this.tenantFilter({ sessionId, seq }))
      .lean();
    if (!doc) throw new NotFoundException('chunk not found');

    // data is a Buffer; return base64 for the frontend to decode
    const base64 = (doc as any).data?.toString('base64') || '';
    return { base64, tFirst: doc.tFirst, tLast: doc.tLast, seq: doc.seq };
  }

  private async ensureSessionExists(sessionId: string, appId: string) {
    const exists = await this.sessions.exists(
      this.tenantFilter({ _id: sessionId, appId }),
    );
    if (!exists) throw new NotFoundException('Session not found');
  }

  private tenantFilter<T extends Record<string, any>>(criteria: T): T & {
    tenantId: string;
  } {
    return { ...criteria, tenantId: this.tenant.tenantId };
  }

  private tenantDoc<T extends Record<string, any>>(doc: T): T & {
    tenantId: string;
  } {
    return { ...doc, tenantId: this.tenant.tenantId };
  }
}
