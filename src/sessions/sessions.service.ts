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
import { TraceSummary } from './schemas/trace-summary.schema';
import { TraceNode } from './schemas/trace-node.schema';
import {
  SessionChatMessage,
} from './schemas/session-chat.schema';
import {
  AppUser,
  AppUserDocument,
} from '../apps/schemas/app-user.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  encryptField,
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from './utils/session-data-crypto';
import { TraceEmbeddingService } from './trace-embedding.service';
import { APP_USER_CHAT_LIMIT } from '../apps/app-user.constants';

type CodeRefEntry = {
  file: string;
  line?: number;
  fn?: string;
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number;
  metadata?: Record<string, any> | null;
};

export type AppSessionShape = {
  sessionId: string;
  appId: string;
  startedAt?: Date;
  finishedAt?: Date;
  notes?: string;
  userEmail?: string;
  userId?: string;
  env?: Record<string, any> | undefined;
  createdAt?: Date;
  updatedAt?: Date;
};

export type SessionListResultShape = {
  items: AppSessionShape[];
  nextCursor?: string;
};

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
    @InjectModel(TraceSummary.name)
    private readonly traceSummaries: Model<TraceSummary>,
    @InjectModel(TraceNode.name) private readonly traceNodes: Model<TraceNode>,
    @InjectModel(SessionChatMessage.name)
    private readonly chatMessages: Model<SessionChatMessage>,
    @InjectModel(AppUser.name)
    private readonly appUsers: Model<AppUserDocument>,
    private readonly tenant: TenantContext,
    private readonly traceEmbeddings: TraceEmbeddingService,
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

  private previewCodeRefValue(value: any, maxLength = 400): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    const trimmed = text.trim();
    if (!trimmed.length) {
      return undefined;
    }
    if (trimmed.length <= maxLength) {
      return trimmed;
    }
    return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private extractCodeRefArgsPreview(event: any): string | undefined {
    const candidate =
      event?.args ??
      event?.body ??
      event?.input ??
      event?.payload ??
      event?.params ??
      event?.meta?.args;
    return this.previewCodeRefValue(candidate);
  }

  private extractCodeRefResultPreview(event: any): string | undefined {
    const candidate =
      event?.result ??
      event?.response ??
      event?.output ??
      event?.return ??
      event?.meta?.result;
    return this.previewCodeRefValue(candidate);
  }

  private extractCodeRefDuration(event: any): number | undefined {
    const duration =
      event?.durMs ??
      event?.durationMs ??
      event?.dur ??
      event?.duration ??
      event?.elapsed ??
      event?.meta?.durMs;
    const value = Number(duration);
    if (Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    return undefined;
  }

  private extractCodeRefMetadata(event: any): Record<string, any> | undefined {
    if (!event || typeof event !== 'object') {
      return undefined;
    }
    const metadata: Record<string, any> = {};
    const message = this.previewCodeRefValue(event.message ?? event.msg, 200);
    if (message) {
      metadata.message = message;
    }
    const status = event.status ?? event.statusCode ?? event.httpStatus;
    if (status !== undefined && status !== null) {
      metadata.status = status;
    }
    const collection = event.collection ?? event.table ?? event.model;
    if (collection) {
      metadata.collection = collection;
    }
    const operation = event.operation ?? event.op ?? event.method;
    if (operation) {
      metadata.operation = operation;
    }
    const url = event.url ?? event.path ?? event.route;
    if (url) {
      metadata.url = url;
    }
    return Object.keys(metadata).length ? metadata : undefined;
  }

  private collectCodeRefsFromTraceEvents(events: any[]): CodeRefEntry[] {
    if (!Array.isArray(events) || !events.length) {
      return [];
    }
    const seen = new Set<string>();
    const refs: CodeRefEntry[] = [];
    for (const event of events) {
      const file =
        typeof event?.file === 'string'
          ? event.file.trim().replace(/\\/g, '/')
          : null;
      if (!file?.length) {
        continue;
      }
      const line =
        typeof event?.line === 'number' && Number.isFinite(event.line)
          ? Math.floor(event.line)
          : undefined;
      const fn =
        typeof event?.fn === 'string' && event.fn.trim().length
          ? event.fn.trim()
          : undefined;
      const key = `${file}|${line ?? 'na'}|${fn ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({
        file,
        line,
        fn,
        argsPreview: this.extractCodeRefArgsPreview(event),
        resultPreview: this.extractCodeRefResultPreview(event),
        durationMs: this.extractCodeRefDuration(event),
        metadata: this.extractCodeRefMetadata(event) ?? null,
      });
      if (refs.length >= 50) {
        break;
      }
    }
    return refs;
  }

  private async appendRequestCodeRefs(
    sessionId: string,
    requestRid: string,
    refs: CodeRefEntry[],
  ): Promise<void> {
    if (!refs.length || !requestRid) {
      return;
    }
    const normalized = refs.map((ref) => ({
      file: ref.file,
      line: typeof ref.line === 'number' ? ref.line : null,
      fn: ref.fn ?? null,
      argsPreview: ref.argsPreview ?? null,
      resultPreview: ref.resultPreview ?? null,
      durationMs:
        typeof ref.durationMs === 'number' && Number.isFinite(ref.durationMs)
          ? ref.durationMs
          : null,
      metadata: ref.metadata ?? null,
    }));
    await this.requests
      .updateOne(this.tenantFilter({ sessionId, rid: requestRid }), {
        $addToSet: {
          codeRefs: {
            $each: normalized,
          },
        },
      })
      .exec()
      .catch(() => undefined);
  }

  private normalizeIncomingCodeRefs(value: any): CodeRefEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const refs: CodeRefEntry[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const file =
        typeof entry.file === 'string' && entry.file.trim().length
          ? entry.file.trim()
          : null;
      if (!file) continue;
      const line =
        typeof entry.line === 'number' && Number.isFinite(entry.line)
          ? Math.floor(entry.line)
          : undefined;
      const fn =
        typeof entry.fn === 'string' && entry.fn.trim().length
          ? entry.fn.trim()
          : undefined;
      const argsPreview =
        typeof entry.argsPreview === 'string'
          ? entry.argsPreview
          : this.previewCodeRefValue(entry.argsPreview);
      const resultPreview =
        typeof entry.resultPreview === 'string'
          ? entry.resultPreview
          : this.previewCodeRefValue(entry.resultPreview);
      const durationMs =
        typeof entry.durationMs === 'number' &&
        Number.isFinite(entry.durationMs)
          ? Math.max(0, Math.round(entry.durationMs))
          : undefined;
      const metadata =
        entry.metadata && typeof entry.metadata === 'object'
          ? entry.metadata
          : undefined;
      refs.push({
        file,
        line,
        fn,
        argsPreview,
        resultPreview,
        durationMs,
        metadata: metadata ?? null,
      });
      if (refs.length >= 100) {
        break;
      }
    }
    return refs;
  }

  private mergeCodeRefEntries(
    primary: CodeRefEntry[],
    secondary: CodeRefEntry[],
    limit = 100,
  ): CodeRefEntry[] {
    const merged: CodeRefEntry[] = [];
    const map = new Map<string, CodeRefEntry>();
    const upsert = (ref: CodeRefEntry) => {
      const key = `${ref.file}|${ref.line ?? 'na'}|${ref.fn ?? ''}`;
      const existing = map.get(key);
      if (!existing) {
        const clone: CodeRefEntry = { ...ref };
        map.set(key, clone);
        merged.push(clone);
        return;
      }
      existing.argsPreview = existing.argsPreview ?? ref.argsPreview;
      existing.resultPreview = existing.resultPreview ?? ref.resultPreview;
      existing.durationMs = existing.durationMs ?? ref.durationMs;
      if (!existing.metadata && ref.metadata) {
        existing.metadata = ref.metadata;
      }
      if (!existing.fn && ref.fn) {
        existing.fn = ref.fn;
      }
      if (existing.line === undefined && ref.line !== undefined) {
        existing.line = ref.line;
      }
    };
    primary.forEach(upsert);
    secondary.forEach(upsert);
    return merged.slice(0, limit);
  }

  private normalizeEntryPoint(value: any):
    | {
        fn?: string | null;
        file?: string | null;
        line?: number | null;
        functionType?: string | null;
        _id?: any;
      }
    | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const fn =
      typeof value.fn === 'string' && value.fn.trim().length
        ? value.fn.trim()
        : undefined;
    const file =
      typeof value.file === 'string' && value.file.trim().length
        ? value.file.trim()
        : undefined;
    const line =
      typeof value.line === 'number' && Number.isFinite(value.line)
        ? Math.floor(value.line)
        : undefined;
    const functionType =
      typeof value.functionType === 'string' && value.functionType.trim().length
        ? value.functionType.trim()
        : undefined;
    const normalized: Record<string, any> = {};
    if (fn) normalized.fn = fn;
    if (file) normalized.file = file;
    if (line !== undefined) normalized.line = line;
    if (functionType) normalized.functionType = functionType;
    if (value._id) normalized._id = value._id;
    return Object.keys(normalized).length ? normalized : undefined;
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
        clockOffsetMs,
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
        if (Object.prototype.hasOwnProperty.call(ev, 'body')) {
          set.body = encryptField(ev.body ?? null);
        }
        if (Object.prototype.hasOwnProperty.call(ev, 'params')) {
          set.params = encryptField(ev.params ?? {});
        }
        if (Object.prototype.hasOwnProperty.call(ev, 'query')) {
          set.query = encryptField(ev.query ?? {});
        }

        const normalizedEntryPoint = this.normalizeEntryPoint(ev.entryPoint);
        if (normalizedEntryPoint) {
          set.entryPoint = normalizedEntryPoint;
        }

        await this.requests.updateOne(
          this.tenantFilter({ sessionId, rid: ev.rid }),
          { $set: set },
          { upsert: true },
        );

        if (ev.aid) {
          await this.actions
            .updateOne(this.tenantFilter({ sessionId, actionId: ev.aid }), {
              $set: { hasReq: true },
            })
            .exec();
        }
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

    const getActionBaseTime = async (
      actionId: string,
    ): Promise<number | null> => {
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
        ? candidates.reduce(
            (max, cur) => (cur > max ? cur : max),
            candidates[0],
          )
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
          if (Object.prototype.hasOwnProperty.call(req, 'body')) {
            set.body = encryptField(req.body ?? null);
          }
          if (Object.prototype.hasOwnProperty.call(req, 'params')) {
            set.params = encryptField(req.params ?? {});
          }
          if (Object.prototype.hasOwnProperty.call(req, 'query')) {
            set.query = encryptField(req.query ?? {});
          }

          const normalizedEntryPoint = this.normalizeEntryPoint(
            req.entryPoint ?? e.entryPoint,
          );
          if (normalizedEntryPoint) {
            set.entryPoint = normalizedEntryPoint;
          }

          const requestDoc = await this.requests.findOneAndUpdate(
            this.tenantFilter({ sessionId, rid: resolvedRid }),
            { $set: set },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );

          if (normalizedActionId) {
            await this.actions
              .updateOne(
                this.tenantFilter({ sessionId, actionId: normalizedActionId }),
                { $set: { hasReq: true } },
              )
              .exec();
          }

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

        if (e.trace) {
          try {
            const ridHint =
              resolvedRid ??
              e?.traceBatch?.rid ??
              e?.requestRid ??
              e?.rid ??
              null;
            const serialized =
              typeof e.trace === 'string'
                ? e.trace
                : JSON.stringify(e.trace);
            const preview =
              typeof serialized === 'string'
                ? serialized.slice(0, 2000)
                : '[unserializable]';
            console.log('[repro][ingest] trace payload received', {
              sessionId,
              rid: ridHint,
              batchIndex: Number.isFinite(Number(e?.traceBatch?.index))
                ? Number(e?.traceBatch?.index)
                : null,
              previewLength: preview.length,
              preview,
            });
          } catch {
            console.log(
              '[repro][ingest] trace payload received (unable to serialize preview)',
            );
          }
        }

        // ---- TRACE BATCH ----
        if (e.trace && e.traceBatch) {
          const batchRid = e.traceBatch?.rid ?? resolvedRid;
          if (batchRid) {
            const eventsForSummaries = this.normalizeTraceEventsForSummary(
              e.trace,
            );
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
              .findOne(this.tenantFilter({ sessionId, rid: batchRid }), {
                _id: 1,
              })
              .lean()
              .exec();

            const eventCodeRefs =
              this.collectCodeRefsFromTraceEvents(eventsForSummaries);
            const suppliedCodeRefs = this.normalizeIncomingCodeRefs(
              e.traceBatch.codeRefs,
            );
            const combinedRefs = this.mergeCodeRefEntries(
              eventCodeRefs,
              suppliedCodeRefs,
            );

            const setPayload: Record<string, any> = {
              tenantId: this.tenant.tenantId,
              sessionId,
              requestRid: batchRid,
              batchIndex,
              data: hasTotal
                ? { events: tracePayload, total: totalValue }
                : tracePayload,
            };
            if (combinedRefs.length) {
              setPayload.codeRefs = combinedRefs;
            }

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

            if (eventsForSummaries.length) {
              try {
                await this.traceEmbeddings.processTraceBatch({
                  tenantId: this.tenant.tenantId,
                  sessionId,
                  requestRid: batchRid,
                  actionId: normalizedActionId ?? null,
                  traceId: null,
                  batchIndex,
                  totalBatches: hasTotal ? totalValue : null,
                  events: eventsForSummaries,
                });
              } catch (traceErr) {
                console.warn(
                  'trace summary pipeline failed',
                  (traceErr as Error)?.message ?? traceErr,
                );
              }
            }

            if (combinedRefs.length) {
              await this.appendRequestCodeRefs(
                sessionId,
                batchRid,
                combinedRefs,
              );
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
            spanContext: d.spanContext,
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

          if (typeof d.spanContext !== 'undefined') {
            changePayload.spanContext = d.spanContext ?? null;
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

  private normalizeTraceEventsForSummary(raw: any): any[] {
    if (!raw) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    if (typeof raw === 'object' && Array.isArray(raw.events)) {
      return raw.events;
    }
    return [];
  }

  private tenantFilter<T extends Record<string, any>>(
    criteria: T,
  ): T & {
    tenantId: string;
  } {
    return { ...criteria, tenantId: this.tenant.tenantId };
  }

  async listSessionsForApp(
    appId: string,
    opts?: {
      limit?: number;
      cursor?: string;
      search?: string;
      status?: 'active' | 'finished';
    },
  ): Promise<SessionListResultShape> {
    const limit = Math.max(1, Math.min(100, Number(opts?.limit) || 20));
    const clauses: Record<string, any>[] = [this.tenantFilter({ appId })];

    if (opts?.status === 'active') {
      clauses.push({
        $or: [{ finishedAt: { $exists: false } }, { finishedAt: null }],
      });
    } else if (opts?.status === 'finished') {
      clauses.push({ finishedAt: { $ne: null } });
    }

    const cursorDate = this.coerceDate(opts?.cursor);
    if (cursorDate) {
      clauses.push({ startedAt: { $lt: cursorDate } });
    }

    const searchClauses = this.buildSessionSearchClauses(opts?.search);
    if (searchClauses.length) {
      clauses.push({ $or: searchClauses });
    }

    const filter =
      clauses.length > 1 ? { $and: clauses } : clauses[0];

    const docs = await this.sessions
      .find(filter)
      .sort({ startedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    let nextCursor: string | undefined;
    if (docs.length > limit) {
      const tail = docs.pop();
      nextCursor = tail?.startedAt
        ? new Date(tail.startedAt).toISOString()
        : undefined;
    }

    const items = docs.map((doc) => this.formatSessionDoc(doc));
    return { items, nextCursor };
  }

  async getSessionForApp(appId: string, sessionId: string): Promise<AppSessionShape> {
    const doc = await this.sessions
      .findOne(this.tenantFilter({ _id: sessionId, appId }))
      .lean();
    if (!doc) {
      throw new NotFoundException('Session not found');
    }
    return this.formatSessionDoc(doc);
  }

  async createSessionForApp(
    appId: string,
    input: {
      notes?: string | null;
      userEmail?: string | null;
      startedAt?: Date | string | number | null;
      finishedAt?: Date | string | number | null;
      env?: Record<string, any> | null;
      userId?: string | null;
    },
  ): Promise<AppSessionShape> {
    const sessionId = 'S_' + randomUUID();
    const startedAt = this.coerceDate(input.startedAt) ?? new Date();
    const finishedAt = this.coerceDate(input.finishedAt);
    const doc = await this.sessions.create(
      this.tenantDoc({
        _id: sessionId,
        appId,
        startedAt,
        finishedAt: finishedAt ?? undefined,
        notes: input.notes?.trim() || undefined,
        userEmail: input.userEmail?.trim() || undefined,
        env: input.env ?? undefined,
        userId: input.userId ?? undefined,
      }),
    );
    return this.formatSessionDoc(doc.toObject());
  }

  async updateSessionForApp(
    appId: string,
    sessionId: string,
    update: {
      notes?: string | null;
      userEmail?: string | null;
      startedAt?: Date | string | number | null;
      finishedAt?: Date | string | number | null;
      env?: Record<string, any> | null;
    },
  ): Promise<AppSessionShape> {
    const doc = await this.sessions.findOne(
      this.tenantFilter({ _id: sessionId, appId }),
    );
    if (!doc) {
      throw new NotFoundException('Session not found');
    }
    if (typeof update.notes !== 'undefined') {
      const trimmed =
        typeof update.notes === 'string' ? update.notes.trim() : undefined;
      doc.notes = trimmed || undefined;
    }
    if (typeof update.userEmail !== 'undefined') {
      const trimmed =
        typeof update.userEmail === 'string'
          ? update.userEmail.trim()
          : undefined;
      doc.userEmail = trimmed || undefined;
    }
    if (typeof update.startedAt !== 'undefined') {
      const coerced = this.coerceDate(update.startedAt);
      if (coerced) {
        doc.startedAt = coerced;
      }
    }
    if (typeof update.finishedAt !== 'undefined') {
      const coerced = this.coerceDate(update.finishedAt);
      doc.finishedAt = coerced ?? undefined;
    }
    if (typeof update.env !== 'undefined') {
      doc.env = update.env ?? undefined;
    }
    await doc.save();
    return this.formatSessionDoc(doc.toObject());
  }

  async deleteSessionForApp(appId: string, sessionId: string) {
    const res = await this.sessions.deleteOne(
      this.tenantFilter({ _id: sessionId, appId }),
    );
    if (!res.deletedCount) {
      throw new NotFoundException('Session not found');
    }

    const filter = this.tenantFilter({ sessionId, appId });
    await Promise.all([
      this.actions.deleteMany(filter),
      this.requests.deleteMany(filter),
      this.changes.deleteMany(filter),
      this.chunks.deleteMany(filter),
      this.emails.deleteMany(filter),
      this.traces.deleteMany(filter),
      this.traceSummaries.deleteMany(filter),
      this.traceNodes.deleteMany(filter),
      this.chatMessages.deleteMany(filter),
    ]);
    return { deleted: true };
  }

  async reserveChatQuota(
    userId: string | undefined,
    tenantId: string | undefined,
  ) {
    if (!userId || !tenantId) {
      return null;
    }
    return this.appUsers
      .findOneAndUpdate(
        {
          _id: userId,
          tenantId,
          chatEnabled: true,
          chatUsageCount: { $lt: APP_USER_CHAT_LIMIT },
        },
        { $inc: { chatUsageCount: 1 } },
        { new: true },
      )
      .lean();
  }

  async releaseChatQuota(
    userId: string | undefined,
    tenantId: string | undefined,
  ) {
    if (!userId || !tenantId) {
      return;
    }
    await this.appUsers.updateOne(
      {
        _id: userId,
        tenantId,
        chatUsageCount: { $gt: 0 },
      },
      { $inc: { chatUsageCount: -1 } },
    );
  }

  private buildSessionSearchClauses(query?: string | null) {
    if (!query || !query.trim()) {
      return [];
    }
    const pattern = this.escapeRegex(query.trim());
    const regex = new RegExp(pattern, 'i');
    return [{ _id: regex }, { notes: regex }, { userEmail: regex }];
  }

  private formatSessionDoc(doc: any): AppSessionShape {
    if (!doc) {
      throw new Error('Cannot format empty session document');
    }
    return {
      sessionId: doc._id,
      appId: doc.appId,
      startedAt: doc.startedAt,
      finishedAt: doc.finishedAt,
      notes: doc.notes,
      userEmail: doc.userEmail,
      userId: doc.userId,
      env: doc.env,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private coerceDate(
    value?: Date | string | number | null,
  ): Date | undefined {
    if (value === null || typeof value === 'undefined') {
      return undefined;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? undefined : value;
    }
    const coerced = new Date(value);
    return Number.isNaN(coerced.getTime()) ? undefined : coerced;
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private tenantDoc<T extends Record<string, any>>(
    doc: T,
  ): T & {
    tenantId: string;
  } {
    return { ...doc, tenantId: this.tenant.tenantId };
  }
}
