import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import OpenAI from 'openai';
import { Session } from './schemas/session.schema';
import { Action } from './schemas/action.schema';
import { RequestEvt } from './schemas/request.schema';
import { DbChange } from './schemas/db-change.schema';
import { EmailEvt } from './schemas/emails.schema';
import { TraceEvt } from './schemas/trace.schema';
import { TraceSummary } from './schemas/trace-summary.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from './utils/session-data-crypto';

const STRING_TRUNCATION_LENGTH = 4000;
const TRACE_EVENT_SAMPLE_LIMIT = 32;
const TRACE_TRACE_SAMPLE_LIMIT = 6;
const TRACE_TOTAL_EVENT_BUDGET =
  TRACE_EVENT_SAMPLE_LIMIT * TRACE_TRACE_SAMPLE_LIMIT;
const TRACE_SEGMENT_LIMIT_PER_TRACE = 6;
const TRACE_SEGMENT_SUMMARY_LENGTH = 800;
const CHAT_MAX_DATASET_CHUNKS = 6;
const CHUNK_SUMMARY_MAX_TOKENS = 450;
const SUMMARY_CHUNK_LIMIT = 40;

@Injectable()
export class SessionSummaryService {
  private openai?: OpenAI;

  constructor(
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(Action.name) private readonly actions: Model<Action>,
    @InjectModel(RequestEvt.name) private readonly requests: Model<RequestEvt>,
    @InjectModel(DbChange.name) private readonly changes: Model<DbChange>,
    @InjectModel(EmailEvt.name) private readonly emails: Model<EmailEvt>,
    @InjectModel(TraceEvt.name) private readonly traces: Model<TraceEvt>,
    @InjectModel(TraceSummary.name)
    private readonly traceSummaries: Model<TraceSummary>,
    private readonly tenant: TenantContext,
    private readonly config: ConfigService,
  ) {}

  async summarizeSession(
    sessionId: string,
    opts?: { appId?: string; hintMessages?: HintMessageParam[] },
  ): Promise<{
    sessionId: string;
    summary: string;
    model: string;
    counts: Record<string, number>;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  }> {
    if (!sessionId || !sessionId.trim()) {
      throw new BadRequestException('sessionId is required');
    }

    const dataset = await this.buildSessionDataset(sessionId, {
      appId: opts?.appId,
      hintMessages: opts?.hintMessages,
    });

    const client = this.ensureClient();
    const model =
      this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';

    let summary = '';
    let usage: UsageTotals | undefined;

    try {
      const summaryResult = await this.generateSessionSummary({
        dataset,
        client,
        model,
        hintMessages: opts?.hintMessages,
      });
      summary = summaryResult.summary;
      usage = summaryResult.usage;
    } catch (err: any) {
      const message =
        err?.message ??
        'Failed to generate summary with the configured OpenAI model.';
      throw new InternalServerErrorException(message);
    }

    return {
      sessionId,
      summary,
      model,
      counts: dataset.counts,
      usage,
    };
  }

  private async generateSessionSummary(params: {
    dataset: SessionDataset;
    client: OpenAI;
    model: string;
    hintMessages?: HintMessageParam[];
  }): Promise<{ summary: string; usage?: UsageTotals }> {
    const { dataset, client, model, hintMessages } = params;
    if (!dataset.chunks.length || dataset.chunks.length === 1) {
      return this.runSingleSummary({
        serialized: dataset.serialized,
        client,
        model,
        hintMessages,
      });
    }
    return this.runChunkedSummary({
      chunks: dataset.chunks,
      client,
      model,
      hintMessages,
    });
  }

  private async runSingleSummary(params: {
    serialized: string;
    client: OpenAI;
    model: string;
    hintMessages?: HintMessageParam[];
  }): Promise<{ summary: string; usage?: UsageTotals }> {
    const { serialized, client, model, hintMessages } = params;
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.25,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior observability analyst. Write concise but comprehensive reports that help technical people understand user impact and give developers specific technical insights. Always cite concrete evidence: include request IDs, action IDs, and any trace filenames with line numbers in the form file.ts:123 when available. Only cite file.ts:123 when the data explicitly includes a filename and numeric line; otherwise state that the code location is unavailable. The summary should look like a technical document.',
        },
        ...this.normalizeHintMessages(hintMessages),
        {
          role: 'user',
          content: [
            'Create a session report with the following structure:',
            '1. Executive Overview (plain language for non-technical readers).',
            '2. Detailed Technical Findings (reference concrete actions, requests, DB changes, emails, and traces; include filenames and line numbers when the trace data provides them).',
            '3. Issues & Anomalies (include errors, failures, slow operations, and cite the exact file:line when known).',
            '',
            'Emphasize timelines, performance metrics, and user impact. Tie together correlated events (e.g., which action triggered a request or DB change). Do not suggest any further actions.',
            '',
            'Session dataset:',
            '```json',
            serialized,
            '```',
          ].join('\n'),
        },
      ],
    });

    const summary =
      completion.choices?.[0]?.message?.content?.trim() ?? 'No summary returned.';
    return { summary, usage: this.mapUsage(completion.usage) };
  }

  private async runChunkedSummary(params: {
    chunks: DatasetChunk[];
    client: OpenAI;
    model: string;
    hintMessages?: HintMessageParam[];
  }): Promise<{ summary: string; usage?: UsageTotals }> {
    const { chunks, client, model, hintMessages } = params;
    const normalizedHints = this.normalizeHintMessages(hintMessages);
    const chunkSummaries: string[] = [];
    let usage: UsageTotals | undefined;
    const limitedChunks =
      chunks.length > SUMMARY_CHUNK_LIMIT
        ? chunks.slice(0, SUMMARY_CHUNK_LIMIT)
        : chunks;
    const omittedCount = chunks.length - limitedChunks.length;

    for (const chunk of limitedChunks) {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.25,
        max_tokens: CHUNK_SUMMARY_MAX_TOKENS,
        messages: [
          {
            role: 'system',
          content:
              'You are an observability analyst generating concise summaries for data chunks. Highlight timelines, performance, user impact, and always mention request IDs, action IDs, and trace filenames with line numbers (file.ts:123) whenever they appear. Only cite file.ts:123 when the chunk includes a filename plus numeric line; otherwise say the code line is unavailable. Keep outputs under 200 words.',
          },
          ...normalizedHints,
          {
            role: 'user',
            content: [
              `Summarize dataset chunk ${chunk.index + 1} of ${chunks.length}.`,
              `Chunk kind: ${chunk.kind}, length: ${chunk.length} characters.`,
              '',
              'Chunk content:',
              '```json',
              chunk.text,
              '```',
            ].join('\n'),
          },
        ],
      });
      const chunkSummary =
        completion.choices?.[0]?.message?.content?.trim() ?? 'No summary';
      chunkSummaries.push(
        [`[Chunk ${chunk.index + 1}/${chunks.length}]`, chunkSummary].join(' '),
      );
      usage = this.mergeUsage(usage, completion.usage);
    }

    if (omittedCount > 0) {
      chunkSummaries.push(
        `(${omittedCount} chunk(s) omitted to stay within token limits. They mostly cover tail data beyond chunk ${limitedChunks.length}.)`,
      );
    }

    const finalCompletion = await client.chat.completions.create({
      model,
      temperature: 0.25,
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior observability analyst. Combine multiple chunk summaries into a single cohesive report with the usual structure, citing filenames and line numbers (file.ts:123) when traces provide them, and explicitly state when no code location is available.',
        },
        ...normalizedHints,
        {
          role: 'user',
          content: [
            'Combine the following chunk summaries into a single session report.',
            'Maintain this structure:',
            '1. Executive Overview',
            '2. Detailed Technical Findings',
            '3. Issues & Anomalies',
            '',
            'Chunk summaries:',
            chunkSummaries.join('\n\n'),
          ].join('\n'),
        },
      ],
    });

    const summary =
      finalCompletion.choices?.[0]?.message?.content?.trim() ??
      'No summary returned.';
    usage = this.mergeUsage(usage, finalCompletion.usage);
    return { summary, usage };
  }

  async chatSession(
    sessionId: string,
    opts: { appId?: string; messages?: HintMessageParam[] },
  ): Promise<{
    sessionId: string;
    reply: string;
    model: string;
    counts: Record<string, number>;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  }> {
    const dataset = await this.buildSessionDataset(sessionId, {
      appId: opts?.appId,
      hintMessages: opts?.messages,
    });

    const client = this.ensureClient();
    const model =
      this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';

    let reply = '';
    let usage:
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        }
      | undefined;

    try {
      const conversation = this.normalizeHintMessages(opts?.messages);
      const hintTokens = this.extractHintTokens(opts?.messages ?? []);
      const selectedChunks = this.selectDatasetChunks(
        dataset.chunks,
        hintTokens,
        CHAT_MAX_DATASET_CHUNKS,
      );
      const expandedChunks = this.expandChunksWithRelated(
        selectedChunks,
        dataset.chunks,
        Math.min(dataset.chunks.length, CHAT_MAX_DATASET_CHUNKS + 4),
      );
      const datasetContext = this.composeChunkContext(
        expandedChunks,
        dataset.chunks.length,
      );

      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
          content:
              'You are a senior observability analyst answering questions about a single session. Base every response solely on the provided context chunks. Reference actions, requests, DB changes, emails, and traces when relevant, and include filenames plus line numbers as `file.ts:123` whenever traces supply them. Only cite `file.ts:123` when the context explicitly includes a filename and numeric line; otherwise clearly state that no code location is available. If the dataset lacks the answer, say you cannot find it.',
          },
          ...conversation,
          {
            role: 'system',
            content: datasetContext,
          },
        ],
      });

      reply =
        completion.choices?.[0]?.message?.content?.trim() ??
        'No response generated.';
      usage = this.mapUsage(completion.usage);
    } catch (err: any) {
      const message =
        err?.message ??
        'Failed to generate a chat response with the configured OpenAI model.';
      throw new InternalServerErrorException(message);
    }

    return {
      sessionId,
      reply,
      model,
      counts: dataset.counts,
      usage,
    };
  }

  private ensureClient(): OpenAI {
    if (this.openai) {
      return this.openai;
    }
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY must be configured to generate summaries.',
      );
    }
    this.openai = new OpenAI({ apiKey });
    return this.openai;
  }

  private async buildSessionDataset(
    sessionId: string,
    opts?: { appId?: string; hintMessages?: HintMessageParam[] },
  ): Promise<SessionDataset> {
    const sessionDoc = await this.sessions
      .findOne(
        this.tenantFilter({
          _id: sessionId,
          ...(opts?.appId ? { appId: opts.appId } : {}),
        }),
      )
      .lean()
      .exec();

    if (!sessionDoc) {
      throw new NotFoundException('Session not found');
    }

    const [actions, requests, dbChanges, emails, traces] = await Promise.all([
      this.collectCursor(
        this.actions
          .find(this.tenantFilter({ sessionId }))
          .sort({ tStart: 1 })
          .lean()
          .cursor(),
        (doc) => this.sanitize(doc),
      ),
      this.collectCursor(
        this.requests
          .find(this.tenantFilter({ sessionId }))
          .sort({ t: 1 })
          .lean()
          .cursor(),
        (doc) => this.sanitize(hydrateRequestDoc(doc)),
      ),
      this.collectCursor(
        this.changes
          .find(this.tenantFilter({ sessionId }))
          .sort({ t: 1 })
          .lean()
          .cursor(),
        (doc) => this.sanitize(hydrateChangeDoc(doc)),
      ),
      this.collectCursor(
        this.emails
          .find(this.tenantFilter({ sessionId }))
          .sort({ t: 1 })
          .lean()
          .cursor(),
        (doc) => this.sanitize(hydrateEmailDoc(doc)),
      ),
      this.collectCursor(
        this.traces
          .find(this.tenantFilter({ sessionId }))
          .sort({ requestRid: 1, batchIndex: 1 })
          .lean()
          .cursor(),
        (doc) => this.sanitize(doc),
      ),
    ]);

    const scopedTimeline = this.scopeTimelineCollections(
      actions,
      requests,
      traces,
      opts?.hintMessages ?? [],
    );
    const trimmedTraces = await this.limitTracePayloads(
      sessionId,
      scopedTimeline.traces,
      opts?.hintMessages ?? [],
    );

    const payload = {
      session: this.sanitize(sessionDoc),
      timeline: {
        actions: scopedTimeline.actions,
        requests: scopedTimeline.requests,
        traces: trimmedTraces,
        dbChanges,
        emails,
      },
    };

    const actionIndex = this.indexActionsById(payload.timeline.actions);
    const requestIndex = this.indexRequestsByRid(payload.timeline.requests);
    const traceIndex = this.indexTraceCodeRefs(payload.timeline.traces);

    const jsonSnapshot = JSON.stringify(payload, this.promptReplacer, 2);
    const retrievalEntries = await this.retrieveRelevantTraceSummaries(
      sessionId,
      opts?.hintMessages ?? [],
      requestIndex,
    );
    const chunks = this.buildDatasetChunks(
      payload,
      jsonSnapshot,
      actionIndex,
      requestIndex,
      traceIndex,
      retrievalEntries,
    );
    const serialized = chunks.map((chunk) => chunk.text).join('\n\n');

    return {
      serialized,
      counts: {
        actions: actions.length,
        requests: requests.length,
        dbChanges: dbChanges.length,
        emails: emails.length,
        traces: traces.length,
      },
      chunks,
    };
  }

  private async collectCursor<T, R = T>(
    cursor: any,
    transform?: (item: T) => R,
  ): Promise<R[]> {
    const out: R[] = [];
    try {
      for await (const item of cursor) {
        const value = transform ? transform(item) : ((item as any) as R);
        out.push(value);
      }
    } finally {
      if (!(cursor as any).closed) {
        await cursor.close().catch(() => undefined);
      }
    }
    return out;
  }

  private sanitize<T>(doc: T): T {
    if (Array.isArray(doc)) {
      return doc.map((item) => this.sanitize(item)) as unknown as T;
    }
    if (!doc || typeof doc !== 'object') {
      return doc;
    }
    const cloned: Record<string, any> = {
      ...(doc as Record<string, any>),
    };
    if ('tenantId' in cloned) delete cloned.tenantId;
    if ('__v' in cloned) delete cloned.__v;
    if ('_id' in cloned) {
      const rawId = cloned._id;
      cloned.id =
        rawId && typeof rawId === 'object' && typeof rawId.toString === 'function'
          ? rawId.toString()
          : rawId;
      delete cloned._id;
    }
    return cloned as T;
  }

  private promptReplacer(_key: string, value: any): any {
    if (Buffer.isBuffer(value)) {
      return value.toString('utf8');
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string' && value.length > STRING_TRUNCATION_LENGTH) {
      return `${value.slice(
        0,
        STRING_TRUNCATION_LENGTH,
      )}\u2026 [truncated for prompt length]`;
    }
    return value;
  }

  private buildDatasetChunks(
    payload: {
      session: Record<string, any>;
      timeline: {
        actions: any[];
        requests: any[];
        traces: any[];
        dbChanges: any[];
        emails: any[];
      };
    },
    jsonSnapshot: string,
    actionIndex: ActionIndex,
    requestIndex: RequestIndex,
    traceIndex: TraceRefIndex,
    retrievalEntries: TraceSummaryEntry[] = [],
  ): DatasetChunk[] {
    const chunks: DatasetChunk[] = [];
    const seenChunkIds = new Set<string>();

    const pushChunk = (
      chunk: Omit<DatasetChunk, 'index' | 'length'> & { text: string },
    ) => {
      const text = (chunk.text ?? '').trim();
      if (!text.length) {
        return;
      }
      if (seenChunkIds.has(chunk.id)) {
        return;
      }
      seenChunkIds.add(chunk.id);
      chunks.push({
        ...chunk,
        text,
        index: chunks.length,
        length: text.length,
      });
    };

    pushChunk({
      id: 'overview',
      kind: 'overview',
      metadata: {
        sessionId: payload.session.id ?? payload.session.sessionId ?? 'unknown',
        appId: payload.session.appId ?? 'unknown',
      },
      text: ['# Session Overview', this.describeSession(payload.session)].join(
        '\n',
      ),
    });

    pushChunk({
      id: 'counts',
      kind: 'counts',
      text: this.buildCountsSection(payload.timeline),
    });

    payload.timeline.actions.forEach((action, index) => {
      pushChunk({
        id: `action:${action?.actionId ?? action?.id ?? index}`,
        kind: 'action',
        metadata: {
          actionId: action?.actionId ?? action?.id,
        },
        text: this.formatActionChunk(action, index),
      });
    });

    payload.timeline.requests.forEach((request, index) => {
      const rid = request?.rid ?? request?.requestRid;
      const requestCodeRefs = this.extractStoredCodeRefs(request?.codeRefs);
      const traceRefs = traceIndex[rid ?? '']?.codeRefs ?? [];
      const combinedRefs = this.mergeCodeRefs(requestCodeRefs, traceRefs);
      pushChunk({
        id: `request:${rid ?? index}`,
        kind: 'request',
        metadata: {
          rid,
          actionId: request?.actionId ?? request?.aid,
          method: request?.method,
          url: this.describeUrl(request?.url),
          codeRefs: this.stringifyCodeRefs(combinedRefs),
        },
        text: this.formatRequestChunk(
          request,
          index,
          actionIndex,
          combinedRefs,
        ),
      });
    });

    payload.timeline.dbChanges.forEach((change, index) => {
      pushChunk({
        id: `db:${index}`,
        kind: 'dbChange',
        metadata: {
          actionId: change?.actionId,
          collection: change?.collection ?? change?.table,
          requestRid: change?.requestRid ?? change?.rid,
        },
        text: this.formatDbChangeChunk(change, index, actionIndex),
      });
    });

    payload.timeline.emails.forEach((email, index) => {
      pushChunk({
        id: `email:${index}`,
        kind: 'email',
        metadata: {
          actionId: email?.actionId,
          to: email?.to,
          subject: email?.subject,
        },
        text: this.formatEmailChunk(email, index),
      });
    });

    payload.timeline.traces.forEach((trace, index) => {
      const rid = trace?.requestRid ?? trace?.rid;
      pushChunk({
        id: `trace:${rid ?? index}:${index}`,
        kind: 'trace',
        metadata: {
          rid,
          actionId: trace?.actionId ?? trace?.aid,
          files: this.collectTraceFilesFromTraceDoc(trace),
        },
        text: this.formatTraceChunk(trace, index, requestIndex, actionIndex),
      });
    });

    retrievalEntries.forEach((entry, idx) => {
      const chunkId = `traceSummary:${entry.groupId}:${entry.segmentIndex}:${idx}`;
      pushChunk({
        id: chunkId,
        kind: 'trace',
        metadata: {
          rid: entry.requestRid ?? undefined,
          actionId: entry.actionId ?? undefined,
          files: this.collectFilesFromPreview(entry.previewEvents),
        },
        text: this.formatTraceSummaryEntryChunk(
          entry,
          requestIndex,
          actionIndex,
        ),
      });
    });

    this.splitRawSnapshot(jsonSnapshot).forEach((text, part) => {
      pushChunk({
        id: `raw:${part + 1}`,
        kind: 'raw',
        metadata: { part: part + 1 },
        text,
      });
    });

    return chunks;
  }

  private describeSession(session: Record<string, any>): string {
    if (!session) {
      return 'No session metadata available.';
    }
    const user = session.userEmail ?? session.userId ?? 'unknown user';
    const started =
      typeof session.startedAt === 'string' || session.startedAt instanceof Date
        ? new Date(session.startedAt).toISOString()
        : 'unknown start';
    const notes = session.notes ? this.toShortText(session.notes, 240) : 'none';
    return [
      `Session ID: ${session.id ?? session.sessionId ?? 'unknown'}`,
      `App ID: ${session.appId ?? 'unknown app'}`,
      `User: ${user}`,
      `Started: ${started}`,
      `Notes: ${notes}`,
    ].join('\n');
  }

  private buildCountsSection(timeline: {
    actions: any[];
    requests: any[];
    traces: any[];
    dbChanges: any[];
    emails: any[];
  }): string {
    return [
      '## Timeline Counts',
      `Actions: ${timeline.actions.length}`,
      `Requests: ${timeline.requests.length}`,
      `Traces: ${timeline.traces.length}`,
      `DB Changes: ${timeline.dbChanges.length}`,
      `Emails: ${timeline.emails.length}`,
    ].join('\n');
  }

  private formatActionChunk(action: any, index: number): string {
    if (!action || typeof action !== 'object') {
      return `## Action ${index + 1}\nNo data`;
    }
    const label = this.toShortText(action.label ?? action.type ?? 'action', 120);
    const actionId = action.actionId ?? action.id ?? `action_${index + 1}`;
    const tStart = this.formatTimestamp(action.tStart ?? action.t ?? null);
    const tEnd = this.formatTimestamp(action.tEnd ?? null);
    const flags = [
      action.hasReq ? 'request' : '',
      action.hasDb ? 'db' : '',
      action.error ? 'error' : '',
    ]
      .filter(Boolean)
      .join(',');
    const duration =
      typeof action.tStart === 'number' && typeof action.tEnd === 'number'
        ? `${Math.max(0, action.tEnd - action.tStart)}ms`
        : '-';
    return [
      `## Action ${index + 1}`,
      `actionId: ${actionId}`,
      `label: ${label}`,
      `timeline: ${tStart} → ${tEnd} (${duration})`,
      `flags: ${flags || 'none'}`,
    ].join('\n');
  }

  private formatRequestChunk(
    request: any,
    index: number,
    actionIndex: ActionIndex,
    refs: CodeRef[],
  ): string {
    if (!request || typeof request !== 'object') {
      return `## Request ${index + 1}\nNo data`;
    }
    const rid = request.rid ?? request.requestRid ?? `req_${index + 1}`;
    const method = (request.method ?? 'GET').toUpperCase();
    const url = this.describeUrl(request.url);
    const status =
      typeof request.status === 'number'
        ? request.status
        : request.error
          ? 'error'
          : 'n/a';
    const actionId = request.actionId ?? request.aid ?? 'unknown';
    const actionRef = this.lookupAction(actionIndex, actionId);
    const codeRefText = refs
      .slice(0, 5)
      .map((ref) => this.formatCodeRef(ref))
      .join(', ');
    const bodyPreview = this.previewJson(request.body);
    const respPreview = this.previewJson(request.respBody);
    const paramsPreview = this.previewJson(request.params);
    const queryPreview = this.previewJson(request.query);
    const headersPreview = this.previewJson(request.headers);
    const duration =
      typeof request.durMs === 'number'
        ? `${Math.round(request.durMs)}ms`
        : request.duration
          ? `${Math.round(request.duration)}ms`
          : '-';
    return [
      `## Request ${index + 1}`,
      `rid: ${rid}`,
      `method: ${method}`,
      `url: ${url}`,
      `status: ${status}`,
      `duration: ${duration}`,
      `actionId: ${actionId}`,
      `actionLabel: ${actionRef?.label ?? 'unknown action'}`,
      actionRef?.startedAt ? `actionStart: ${actionRef.startedAt}` : undefined,
      bodyPreview ? `body: ${bodyPreview}` : undefined,
      respPreview ? `response: ${respPreview}` : undefined,
      paramsPreview ? `params: ${paramsPreview}` : undefined,
      queryPreview ? `query: ${queryPreview}` : undefined,
      headersPreview ? `headers: ${headersPreview}` : undefined,
      codeRefText ? `codeRefs: ${codeRefText}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatDbChangeChunk(
    change: any,
    index: number,
    actionIndex: ActionIndex,
  ): string {
    if (!change || typeof change !== 'object') {
      return `## DB Change ${index + 1}\nNo data`;
    }
    const collection = change.collection ?? change.table ?? 'unknown';
    const op = change.op ?? change.operation ?? 'op';
    const rid = change.requestRid ?? change.rid ?? 'n/a';
    const actionId = change.actionId ?? 'n/a';
    const actionRef = this.lookupAction(actionIndex, actionId);
    return [
      `## DB Change ${index + 1}`,
      `operation: ${op}`,
      `collection: ${collection}`,
      `requestRid: ${rid}`,
      `actionId: ${actionId}`,
      `actionLabel: ${actionRef?.label ?? 'unknown action'}`,
      change.error ? `error: ${this.previewJson(change.error)}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatEmailChunk(email: any, index: number): string {
    if (!email || typeof email !== 'object') {
      return `## Email ${index + 1}\nNo data`;
    }
    const subject = this.toShortText(email.subject ?? '(no subject)', 160);
    const to = Array.isArray(email.to) ? email.to.join(', ') : email.to ?? '';
    const cc = Array.isArray(email.cc) ? email.cc.join(', ') : email.cc ?? '';
    const bcc =
      Array.isArray(email.bcc) ? email.bcc.join(', ') : email.bcc ?? '';
    const textPreview = this.toShortText(email.text, 200);
    return [
      `## Email ${index + 1}`,
      `subject: ${subject}`,
      `to: ${to || 'unknown'}`,
      cc ? `cc: ${cc}` : undefined,
      bcc ? `bcc: ${bcc}` : undefined,
      textPreview ? `bodyPreview: ${textPreview}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatTraceChunk(
    trace: any,
    index: number,
    requestIndex: RequestIndex,
    actionIndex: ActionIndex,
  ): string {
    if (!trace || typeof trace !== 'object') {
      return `## Trace ${index + 1}\nNo data`;
    }
    const rid = trace.requestRid ?? trace.rid ?? 'n/a';
    const actionId = trace.actionId ?? trace.aid ?? 'n/a';
    const requestRef = this.lookupRequest(requestIndex, rid);
    const actionRef = this.lookupAction(actionIndex, actionId);
    const segments = this.describeTraceSegmentsDetailed(trace.data);
    const codeRefs = this.mergeCodeRefs(
      this.extractStoredCodeRefs(trace.codeRefs),
      this.extractTraceCodeRefsFromData(trace.data),
    )
      .map((ref) => this.formatCodeRef(ref))
      .slice(0, 8)
      .join(', ');
    return [
      `## Trace ${index + 1}`,
      `requestRid: ${rid}`,
      `request: ${requestRef ? `${requestRef.method} ${requestRef.url}` : 'unknown'}`,
      `actionId: ${actionId}`,
      `actionLabel: ${actionRef?.label ?? 'unknown action'}`,
      `segments:`,
      segments,
      codeRefs ? `codeRefs: ${codeRefs}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private describeTraceSegmentsDetailed(data: any): string {
    if (!data) {
      return '  - No trace data.';
    }
    if (Array.isArray(data.events)) {
      return data.events
        .map(
          (event: any, idx: number) =>
            `  - [${idx + 1}] ${event.fn ?? 'fn'} (${event.file ?? 'file'}:${event.line ?? '?'}) ${event.message ?? event.type ?? ''}`,
        )
        .join('\n');
    }
    if (Array.isArray(data.segments)) {
      return data.segments
        .slice(0, 5)
        .map((segment: any) => {
          const snippet = this.toShortText(segment.summary, 280);
          const file = segment.previewEvents?.find((evt: any) => evt.file)?.file;
          const line =
            segment.previewEvents?.find((evt: any) => evt.line)?.line ?? null;
          const fileRef = file ? `${file}${line ? `:${line}` : ''}` : '';
          return `  - segment ${segment.segmentIndex} (events=${segment.eventCount}) ${fileRef} ${snippet}`;
        })
        .join('\n');
    }
    if (data.omitted) {
      return `  - omitted (${data.reason ?? 'budget'})`;
    }
    if (data.events && Array.isArray(data.events.events)) {
      return this.describeTraceSegmentsDetailed(data.events);
    }
    return '  - No readable segments.';
  }

  private previewJson(value: any, maxLength = 400): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    try {
      const text = JSON.stringify(value);
      if (text.length <= maxLength) {
        return text;
      }
      return `${text.slice(0, maxLength)}…`;
    } catch {
      const text = String(value);
      return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
    }
  }

  private splitRawSnapshot(snapshot: string, partSize = 8000): string[] {
    if (!snapshot?.length) {
      return [];
    }
    const out: string[] = [];
    for (let i = 0; i < snapshot.length; i += partSize) {
      out.push(
        ['## Raw JSON Snapshot', '```json', snapshot.slice(i, i + partSize), '```'].join('\n'),
      );
    }
    return out;
  }

  private collectTraceFilesFromTraceDoc(trace: any): string[] {
    const stored = this.extractStoredCodeRefs(trace?.codeRefs);
    if (stored.length) {
      return stored.map((ref) => ref.file.toLowerCase());
    }
    return this.extractTraceCodeRefsFromData(trace?.data).map((ref) =>
      ref.file.toLowerCase(),
    );
  }

  private indexTraceCodeRefs(traces: any[]): TraceRefIndex {
    const map: TraceRefIndex = {};
    for (const trace of traces ?? []) {
      if (!trace || typeof trace !== 'object') continue;
      const rid = trace.requestRid ?? trace.rid;
      if (!rid) continue;
      const refs = Array.isArray(trace.codeRefs) && trace.codeRefs.length
        ? trace.codeRefs
            .map((ref: any) => this.normalizeStoredCodeRef(ref))
            .filter((ref): ref is CodeRef => Boolean(ref))
        : this.extractTraceCodeRefsFromData(trace.data);
      if (!refs.length) continue;
      map[rid] = {
        rid,
        codeRefs: refs,
      };
    }
    return map;
  }

  private extractTraceCodeRefsFromData(data: any): CodeRef[] {
    const refs: CodeRef[] = [];
    if (!data) {
      return refs;
    }
    const addRef = (file?: string | null, line?: number | null, fn?: string | null) => {
      if (!file) {
        return;
      }
      const normalized = this.normalizeFileHint(file);
      if (!normalized.length) {
        return;
      }
      refs.push({
        file: normalized,
        line:
          typeof line === 'number' && Number.isFinite(line)
            ? Math.floor(line)
            : undefined,
        fn: fn ?? undefined,
      });
    };
    const events = this.normalizeTraceEvents(data);
    for (const event of events) {
      addRef(event?.file, event?.line, event?.fn);
    }
    if (Array.isArray(data.segments)) {
      for (const segment of data.segments) {
        segment.previewEvents?.forEach((evt: any) =>
          addRef(evt?.file, evt?.line, evt?.fn),
        );
      }
    }
    return refs;
  }

  private formatCodeRef(ref: CodeRef | string): string {
    if (typeof ref === 'string') {
      return ref;
    }
    const parts = [ref.file];
    if (ref.line != null) {
      parts.push(`:${ref.line}`);
    }
    if (ref.fn) {
      parts.push(`(${ref.fn})`);
    }
    return parts.join('');
  }

  private describeUrl(url: any): string {
    if (!url) {
      return '/';
    }
    const text = typeof url === 'string' ? url : JSON.stringify(url);
    try {
      const parsed = new URL(text, 'https://dummy');
      const path = parsed.pathname ?? '/';
      return `${path}${parsed.search ?? ''}`;
    } catch {
      const shortened = this.toShortText(text, 160);
      return shortened ?? text;
    }
  }

  private indexActionsById(actions: any[]): ActionIndex {
    const map: ActionIndex = {};
    for (const action of actions ?? []) {
      if (!action || typeof action !== 'object') {
        continue;
      }
      const key = action.actionId ?? action.id;
      if (!key) continue;
      map[key] = {
        actionId: key,
        label: this.toShortText(action.label ?? action.type, 160) ?? key,
        startedAt: this.formatTimestamp(action.tStart ?? action.t),
        endedAt: this.formatTimestamp(action.tEnd),
      };
    }
    return map;
  }

  private indexRequestsByRid(requests: any[]): RequestIndex {
    const map: RequestIndex = {};
    for (const request of requests ?? []) {
      if (!request || typeof request !== 'object') {
        continue;
      }
      const rid = request.rid ?? request.requestRid;
      if (!rid) continue;
      map[rid] = {
        rid,
        method: (request.method ?? 'GET').toUpperCase(),
        url: this.describeUrl(request.url),
      };
    }
    return map;
  }

  private lookupAction(
    actionIndex: ActionIndex,
    actionId?: string | null,
  ): ActionIndexEntry | undefined {
    if (!actionId) {
      return undefined;
    }
    return actionIndex[actionId];
  }

  private lookupRequest(
    requestIndex: RequestIndex,
    rid?: string | null,
  ): RequestIndexEntry | undefined {
    if (!rid) {
      return undefined;
    }
    return requestIndex[rid];
  }

  private normalizeStoredCodeRef(entry: any): CodeRef | undefined {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const file =
      typeof entry.file === 'string' && entry.file.trim().length
        ? entry.file.trim()
        : undefined;
    if (!file) {
      return undefined;
    }
    const line =
      typeof entry.line === 'number' && Number.isFinite(entry.line)
        ? Math.floor(entry.line)
        : undefined;
    const fn =
      typeof entry.fn === 'string' && entry.fn.trim().length
        ? entry.fn.trim()
        : undefined;
    return { file: this.normalizeFileHint(file) || file, line, fn };
  }

  private extractStoredCodeRefs(entries: any): CodeRef[] {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map((entry) => this.normalizeStoredCodeRef(entry))
      .filter((entry): entry is CodeRef => Boolean(entry));
  }

  private mergeCodeRefs(primary: CodeRef[], secondary: CodeRef[]): CodeRef[] {
    if (!secondary?.length) {
      return primary.slice();
    }
    const merged: CodeRef[] = [];
    const seen = new Set<string>();
    const push = (ref: CodeRef) => {
      const key = `${ref.file}|${ref.line ?? 'na'}|${ref.fn ?? ''}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(ref);
    };
    primary.forEach((ref) => push(ref));
    secondary.forEach((ref) => push(ref));
    return merged;
  }

  private stringifyCodeRefs(refs: CodeRef[]): string[] {
    if (!refs?.length) {
      return [];
    }
    return refs.slice(0, 10).map((ref) => this.formatCodeRef(ref));
  }

  private formatTraceSummaryEntryChunk(
    entry: TraceSummaryEntry,
    requestIndex: RequestIndex,
    actionIndex: ActionIndex,
  ): string {
    const rid = entry.requestRid ?? 'n/a';
    const actionId = entry.actionId ?? 'n/a';
    const requestRef = this.lookupRequest(requestIndex, rid);
    const actionRef = this.lookupAction(actionIndex, actionId);
    const preview = (entry.previewEvents ?? [])
      .slice(0, 5)
      .map((evt, idx) => {
        const file = evt?.file ?? 'file';
        const line =
          typeof evt?.line === 'number' && Number.isFinite(evt.line)
            ? evt.line
            : '?';
        const fn = evt?.fn ? ` ${evt.fn}` : '';
        return `  - [${idx + 1}] ${file}:${line}${fn}`;
      })
      .join('\n');
    return [
      `## Trace Segment`,
      `requestRid: ${rid}`,
      `request: ${requestRef ? `${requestRef.method} ${requestRef.url}` : 'unknown'}`,
      `actionId: ${actionId}`,
      `actionLabel: ${actionRef?.label ?? 'unknown action'}`,
      `events: ${entry.eventCount} (segment ${entry.segmentIndex})`,
      `summary:`,
      entry.summary,
      preview ? `preview:\n${preview}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private collectFilesFromPreview(
    events?: Array<{ file?: string | null }>,
  ): string[] {
    if (!events?.length) {
      return [];
    }
    const files = new Set<string>();
    for (const event of events) {
      const file =
        typeof event?.file === 'string' && event.file.trim().length
          ? event.file.trim().toLowerCase()
          : null;
      if (file) {
        files.add(file);
      }
    }
    return Array.from(files);
  }

  private buildKeywordRegex(keywords: string[]): string {
    return keywords
      .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
  }

  private formatTimestamp(value: any): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string') {
      return value;
    }
    return '-';
  }

  private selectDatasetChunks(
    chunks: DatasetChunk[],
    tokens: HintTokens,
    maxChunks: number,
  ): DatasetChunk[] {
    if (!chunks?.length) {
      return [];
    }
    if (chunks.length <= maxChunks || maxChunks <= 0) {
      return chunks;
    }

    const scored = chunks.map((chunk) => ({
      chunk,
      score: this.scoreDatasetChunk(chunk, tokens),
    }));

    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.chunk.index - b.chunk.index;
      }
      return b.score - a.score;
    });

    const selected = scored.slice(0, maxChunks);
    const hasSignal = selected.some((item) => item.score > 0);
    if (!hasSignal) {
      return chunks.slice(0, maxChunks);
    }

    return selected
      .map((item) => item.chunk)
      .sort((a, b) => a.index - b.index);
  }

  private scoreDatasetChunk(chunk: DatasetChunk, tokens: HintTokens): number {
    if (!chunk?.text) {
      return 0;
    }
    const text = chunk.text.toLowerCase();
    let score = 0;
    const keywordList = Array.from(tokens.keywords);

    tokens.files.forEach((file) => {
      if (file && text.includes(file)) {
        score += 5;
      }
    });
    tokens.fileBases.forEach((base) => {
      if (base && text.includes(base)) {
        score += 3;
      }
    });
    tokens.functions.forEach((fn) => {
      if (fn && text.includes(fn)) {
        score += 2;
      }
    });
    tokens.lines.forEach((line) => {
      if (
        typeof line === 'number' &&
        line >= 0 &&
        text.includes(`:${line}`)
      ) {
        score += 1;
      }
    });
    tokens.keywords.forEach((keyword) => {
      if (keyword && text.includes(keyword)) {
        score += 1;
      }
    });
    if (chunk.metadata?.url) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.url),
        keywordList,
      );
    }
    if (chunk.metadata?.rid) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.rid),
        keywordList,
      );
    }
    if (chunk.metadata?.actionId) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.actionId),
        keywordList,
      );
    }
    if (Array.isArray(chunk.metadata?.files)) {
      for (const file of chunk.metadata.files) {
        const normalized = this.normalizeFileHint(file);
        if (tokens.files.has(normalized) || tokens.fileBases.has(this.getBasename(normalized))) {
          score += 5;
        }
        score += this.scoreTextAgainstKeywords(file, keywordList);
      }
    }
    if (chunk.kind === 'request' && tokens.keywords.size) {
      score += 1; // slight preference to include request context
    }
    return score;
  }

  private expandChunksWithRelated(
    selected: DatasetChunk[],
    allChunks: DatasetChunk[],
    limit: number,
  ): DatasetChunk[] {
    if (!selected.length || selected.length >= limit) {
      return selected.slice(0, limit);
    }
    const out = [...selected];
    const seen = new Set(selected.map((chunk) => chunk.id));
    const relatedKeys = new Set<string>();
    selected.forEach((chunk) => {
      const meta = chunk.metadata ?? {};
      if (meta.rid) relatedKeys.add(`rid:${meta.rid}`);
      if (meta.actionId) relatedKeys.add(`action:${meta.actionId}`);
    });

    for (const chunk of allChunks) {
      if (out.length >= limit) break;
      if (seen.has(chunk.id)) continue;
      const meta = chunk.metadata ?? {};
      if (
        (meta.rid && relatedKeys.has(`rid:${meta.rid}`)) ||
        (meta.actionId && relatedKeys.has(`action:${meta.actionId}`))
      ) {
        out.push(chunk);
        seen.add(chunk.id);
      }
    }

    return out;
  }

  private composeChunkContext(
    chunks: DatasetChunk[],
    totalChunks: number,
  ): string {
    if (!chunks?.length) {
      return 'Session dataset context unavailable: no chunks selected.';
    }
    const header = [
      `Session dataset context (selected ${chunks.length} of ${totalChunks} chunk(s)).`,
      'Chunks preserve logical entities such as requests, actions, and traces.',
    ].join(' ');

    const body = chunks
      .map((chunk) =>
        [
          `Chunk ${chunk.index + 1}/${totalChunks} [${chunk.kind}] ${this.describeChunkMetadata(chunk)}`,
          '```',
          chunk.text,
          '```',
        ].join('\n'),
      )
      .join('\n\n');

    return [header, body].join('\n\n');
  }

  private describeChunkMetadata(chunk: DatasetChunk): string {
    if (!chunk?.metadata) {
      return '';
    }
    const meta = chunk.metadata;
    const parts: string[] = [];
    if (meta.rid) parts.push(`rid=${meta.rid}`);
    if (meta.actionId) parts.push(`actionId=${meta.actionId}`);
    if (meta.method && meta.url) parts.push(`${meta.method} ${meta.url}`);
    if (meta.collection) parts.push(`collection=${meta.collection}`);
    if (meta.files?.length) parts.push(`files=${meta.files.slice(0, 2).join(',')}`);
    if (meta.part) parts.push(`rawPart=${meta.part}`);
    return parts.join(' ');
  }

  private scopeTimelineCollections<TAction, TRequest, TTrace>(
    actions: TAction[],
    requests: TRequest[],
    traces: TTrace[],
    hintMessages: HintMessageParam[] = [],
  ): { actions: TAction[]; requests: TRequest[]; traces: TTrace[] } {
    const tokens = this.extractHintTokens(hintMessages);
    const prioritizedTraces = this.rankTracesByHints(traces, tokens);
    const keywordTraces = this.filterTracesByKeywords(traces, tokens);

    const baseTraces = prioritizedTraces.length
      ? prioritizedTraces
      : this.sampleEvenly(traces, 25);
    const scopedTraces = this.mergeCollections(
      baseTraces,
      keywordTraces,
      25,
    );

    const prioritizedRequestIds = new Set(
      prioritizedTraces
        .map((trace: any) => this.resolveRequestId(trace))
        .filter((rid): rid is string => Boolean(rid)),
    );

    const baseRequests = prioritizedRequestIds.size
      ? this.composePrioritizedRequests(
          requests,
          prioritizedRequestIds,
          tokens,
        )
      : this.sampleEvenly(requests, 12);
    const keywordRequests = this.filterRequestsByKeywords(requests, tokens);
    const scopedRequests = this.mergeCollections(
      baseRequests,
      keywordRequests,
      14,
    );

    return {
      actions,
      requests: scopedRequests,
      traces: scopedTraces,
    };
  }

  private async limitTracePayloads<TTrace>(
    sessionId: string,
    traces: TTrace[],
    hintMessages: HintMessageParam[] = [],
  ): Promise<TTrace[]> {
    if (!traces?.length) {
      return traces;
    }

    const result: TTrace[] = [];
    let remainingEvents = TRACE_TOTAL_EVENT_BUDGET;
    let included = 0;
    const tokens = this.extractHintTokens(hintMessages);
    const summaries = await this.fetchTraceSummaries(sessionId, traces);

    for (const trace of traces) {
      const canInclude =
        included < TRACE_TRACE_SAMPLE_LIMIT && remainingEvents > 0;
      if (!canInclude) {
        result.push(this.buildTracePlaceholder(trace, 'trace_budget_exhausted'));
        continue;
      }

      const limited = this.limitTracePayload(trace, remainingEvents);
      remainingEvents = Math.max(0, remainingEvents - limited.eventsUsed);
      included += 1;

      const groupId = this.resolveTraceGroupId(limited.payload);
      const segmentEntries = groupId ? summaries.get(groupId) ?? [] : [];
      const segmentPayload = this.buildTraceSegmentPayloads(
        segmentEntries,
        tokens,
      );
      const withSegments = this.attachTraceSegments(
        limited.payload,
        segmentPayload,
        segmentEntries.length,
      );

      result.push(withSegments);
    }

    return result;
  }

  private limitTracePayload<TTrace>(
    trace: TTrace,
    eventBudget: number,
  ): { payload: TTrace; eventsUsed: number } {
    if (!trace || typeof trace !== 'object') {
      return { payload: trace, eventsUsed: 0 };
    }
    const cloned: Record<string, any> = {
      ...(trace as Record<string, any>),
    };
    if ('data' in cloned) {
      const limited = this.limitTraceData(cloned.data, eventBudget);
      cloned.data = limited.data;
      return { payload: cloned as TTrace, eventsUsed: limited.eventsUsed };
    }
    return { payload: cloned as TTrace, eventsUsed: 0 };
  }

  private limitTraceData(data: any, eventBudget: number): TraceDataLimitResult {
    if (!data) {
      return { data, eventsUsed: 0 };
    }

    const events = this.normalizeTraceEvents(data);
    if (!events.length) {
      return { data, eventsUsed: 0 };
    }

    const perTraceLimit = Math.max(
      1,
      Math.min(eventBudget, TRACE_EVENT_SAMPLE_LIMIT),
    );

    const sample =
      events.length <= perTraceLimit
        ? events
        : this.sampleEvenly(events, perTraceLimit);
    const compacted = this.compactTraceEvents(sample);
    const summary = {
      totalEvents: events.length,
      sampleSize: compacted.length,
      truncatedEvents: Math.max(0, events.length - compacted.length),
      sampleStrategy: events.length <= perTraceLimit ? 'all' : 'even',
      events: compacted,
    };

    return {
      data: summary,
      eventsUsed: compacted.length,
    };
  }

  private compactTraceEvents(events: TraceEventLike[]): CompactTraceEvent[] {
    if (!events?.length) {
      return [];
    }
    return events.map((event, index) => ({
      index,
      fn: this.toShortText(event?.fn, 80),
      file: this.compactFilePath(this.toShortText(event?.file, 120)),
      line:
        typeof event?.line === 'number' && Number.isFinite(event.line)
          ? Math.floor(event.line)
          : undefined,
      type: this.toShortText((event as any)?.type, 40),
      message: this.pickEventMessage(event),
      durationMs: this.normalizeDuration(
        (event as any)?.dur ?? (event as any)?.durationMs,
      ),
    }));
  }

  private toShortText(value: any, max = 120): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const text = String(value).trim();
    if (!text.length) {
      return undefined;
    }
    if (text.length <= max) {
      return text;
    }
    return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
  }

  private compactFilePath(file?: string): string | undefined {
    if (!file) {
      return undefined;
    }
    const normalized = file.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts.slice(-3).join('/');
  }

  private pickEventMessage(event: TraceEventLike): string | undefined {
    const candidates = [
      (event as any)?.message,
      (event as any)?.msg,
      (event as any)?.error,
      (event as any)?.err,
      (event as any)?.detail,
      (event as any)?.summary,
    ];
    for (const candidate of candidates) {
      const text = this.toShortText(candidate, 160);
      if (text) {
        return text;
      }
    }
    return undefined;
  }

  private normalizeDuration(value: any): number | undefined {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    return Math.max(0, Math.round(num));
  }

  private mapUsage(usage?: ChatUsage): UsageTotals | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  private mergeUsage(
    base: UsageTotals | undefined,
    usage?: ChatUsage,
  ): UsageTotals | undefined {
    if (!usage) {
      return base;
    }
    const mapped = this.mapUsage(usage);
    if (!mapped) {
      return base;
    }
    return {
      promptTokens: (base?.promptTokens ?? 0) + (mapped.promptTokens ?? 0),
      completionTokens:
        (base?.completionTokens ?? 0) + (mapped.completionTokens ?? 0),
      totalTokens: (base?.totalTokens ?? 0) + (mapped.totalTokens ?? 0),
    };
  }

  private async fetchTraceSummaries<TTrace>(
    sessionId: string,
    traces: TTrace[],
  ): Promise<Map<string, TraceSummaryEntry[]>> {
    const groupIds = Array.from(
      new Set(
        traces
          .map((trace: any) => this.resolveTraceGroupId(trace))
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (!groupIds.length) {
      return new Map();
    }

    const requests = groupIds.map((groupId) =>
      this.traceSummaries
        .find(
          this.tenantFilter({
            sessionId,
            groupId,
          }),
        )
        .sort({ segmentIndex: 1 })
        .limit(TRACE_SEGMENT_LIMIT_PER_TRACE * 4)
        .lean()
        .exec()
        .then((docs) => ({ groupId, docs })),
    );

    const result = await Promise.all(requests);
    const map = new Map<string, TraceSummaryEntry[]>();
    for (const entry of result) {
      map.set(
        entry.groupId,
        (entry.docs ?? []) as unknown as TraceSummaryEntry[],
      );
    }
    return map;
  }

  private async retrieveRelevantTraceSummaries(
    sessionId: string,
    hintMessages: HintMessageParam[],
    requestIndex: RequestIndex,
    limit = 6,
  ): Promise<TraceSummaryEntry[]> {
    const tokens = this.extractHintTokens(hintMessages);
    const keywords = Array.from(tokens.keywords).filter(Boolean).slice(0, 6);
    const baseQuery = this.tenantFilter({ sessionId });
    const queries = keywords.length
      ? [
          {
            ...baseQuery,
            summary: {
              $regex: this.buildKeywordRegex(keywords),
              $options: 'i',
            },
          },
          baseQuery,
        ]
      : [baseQuery];

    const collected: TraceSummaryEntry[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      const docs = await this.traceSummaries
        .find(query)
        .sort(
          keywords.length
            ? { updatedAt: -1 }
            : { eventCount: -1, segmentIndex: 1 },
        )
        .limit(limit * 4)
        .lean()
        .exec();

      for (const doc of docs ?? []) {
        const key = `${doc.groupId}:${doc.segmentIndex}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push(doc as TraceSummaryEntry);
        if (collected.length >= limit * 3) {
          break;
        }
      }

      if (collected.length >= limit * 2) {
        break;
      }
    }

    if (!collected.length) {
      return [];
    }

    const scored = collected.map((entry, index) => ({
      entry,
      index,
      score: this.scoreTraceSummaryEntry(entry, tokens, requestIndex),
    }));

    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    });

    return scored
      .filter((item) => item.score > 0)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  private buildTraceSegmentPayloads(
    entries: TraceSummaryEntry[],
    tokens: HintTokens,
  ): TraceSegmentPayload[] {
    if (!entries?.length) {
      return [];
    }
    const ranked = this.rankTraceSegments(entries, tokens);
    const selected = ranked.slice(0, TRACE_SEGMENT_LIMIT_PER_TRACE);
    return selected.map((entry) => ({
      segmentIndex: entry.segmentIndex,
      summary: this.truncateText(entry.summary, TRACE_SEGMENT_SUMMARY_LENGTH),
      eventStart: entry.eventStart,
      eventEnd: entry.eventEnd,
      eventCount: entry.eventCount,
      previewEvents: this.compactPreviewEvents(entry.previewEvents),
    }));
  }

  private rankTraceSegments(
    entries: TraceSummaryEntry[],
    tokens: HintTokens,
  ): TraceSummaryEntry[] {
    const scored = entries.map((entry, index) => ({
      entry,
      index,
      score: this.scoreTraceSegment(entry, tokens),
    }));
    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    });
    return scored.map((item) => item.entry);
  }

  private scoreTraceSegment(entry: TraceSummaryEntry, tokens: HintTokens): number {
    let score = 0;
    if (!tokens.hasDirectHints) {
      return entry.segmentIndex < TRACE_SEGMENT_LIMIT_PER_TRACE ? 1 : 0;
    }
    const text = entry.summary?.toLowerCase?.() ?? '';
    tokens.files.forEach((file) => {
      if (file && text.includes(file)) {
        score += 3;
      }
    });
    tokens.fileBases.forEach((base) => {
      if (base && text.includes(base)) {
        score += 2;
      }
    });
    tokens.functions.forEach((fn) => {
      if (fn && text.includes(fn)) {
        score += 2;
      }
    });
    tokens.lines.forEach((line) => {
      if (
        typeof line === 'number' &&
        text.includes(`:${line}`) // heuristically match file:line
      ) {
        score += 1;
      }
    });
    const previewScore = this.scoreTrace(
      (entry.previewEvents ?? []) as TraceEventLike[],
      tokens,
    );
    score += previewScore;
    return score;
  }

  private compactPreviewEvents(
    events?: Array<{ fn?: string | null; file?: string | null; line?: number | null; type?: string | null }>,
  ): TracePreviewEvent[] {
    if (!events?.length) {
      return [];
    }
    return events.slice(0, 5).map((event) => ({
      fn: this.toShortText(event?.fn, 80),
      file: this.compactFilePath(this.toShortText(event?.file, 120)),
      line:
        typeof event?.line === 'number' && Number.isFinite(event.line)
          ? Math.floor(event.line)
          : undefined,
      type: this.toShortText(event?.type, 40),
    }));
  }

  private truncateText(value: string, maxLength: number): string {
    if (!value || value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1))}\u2026`;
  }

  private attachTraceSegments<TTrace>(
    trace: TTrace,
    segments: TraceSegmentPayload[],
    totalSegments: number,
  ): TTrace {
    if (!trace || typeof trace !== 'object') {
      return trace;
    }
    const cloned: Record<string, any> = {
      ...(trace as Record<string, any>),
    };
    const meta =
      cloned.data && typeof cloned.data === 'object'
        ? this.extractTraceDataMeta(cloned.data)
        : undefined;
    cloned.data = {
      ...(meta ?? {}),
      chunked: true,
      totalSegments,
      includedSegments: segments.length,
      segments,
      note:
        'Trace events chunked to respect model context limits. Each segment summarizes a chronological block of events.',
    };
    return cloned as TTrace;
  }

  private extractTraceDataMeta(data: any): Record<string, any> | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }
    const keys = ['total', 'batchIndex', 'requestRid', 'traceId'];
    const meta: Record<string, any> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        meta[key] = data[key];
      }
    }
    return Object.keys(meta).length ? meta : undefined;
  }

  private buildTracePlaceholder<TTrace>(
    trace: TTrace,
    reason: string,
  ): TTrace {
    if (!trace || typeof trace !== 'object') {
      return trace;
    }
    const events = this.normalizeTraceEvents((trace as any)?.data);
    const placeholder = {
      omitted: true,
      reason,
      totalEvents: events.length,
      note:
        'Trace omitted from prompt to stay within model context window. Provide more specific hints to focus on the right trace.',
    };
    return {
      ...(trace as Record<string, any>),
      data: placeholder,
    } as TTrace;
  }

  private composePrioritizedRequests<TRequest>(
    requests: TRequest[],
    prioritizedIds: Set<string>,
    tokens: HintTokens,
  ): TRequest[] {
    const prioritized: TRequest[] = [];
    const remainder: TRequest[] = [];
    for (const req of requests) {
      const rid = this.resolveRequestId(req);
      if (rid && prioritizedIds.has(rid)) {
        prioritized.push(req);
      } else {
        remainder.push(req);
      }
    }

    const need = Math.max(0, 8 - prioritized.length);
    const fallback = need ? this.sampleEvenly(remainder, need) : [];

    if (!prioritized.length && tokens.hasDirectHints) {
      return this.sampleEvenly(requests, 8);
    }

    return [...prioritized, ...fallback];
  }

  private filterRequestsByKeywords<TRequest>(
    requests: TRequest[],
    tokens: HintTokens,
  ): TRequest[] {
    if (!requests?.length || !tokens.keywords.size) {
      return [];
    }
    const keywords = Array.from(tokens.keywords);
    const scored = requests
      .map((request, index) => {
        const text = this.buildRequestSearchText(request);
        const score = this.scoreTextAgainstKeywords(text, keywords);
        return { request, score, index };
      })
      .filter((entry) => entry.score > 0);
    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    });
    return scored.slice(0, 20).map((entry) => entry.request);
  }

  private filterTracesByKeywords<TTrace>(
    traces: TTrace[],
    tokens: HintTokens,
  ): TTrace[] {
    if (!traces?.length || !tokens.keywords.size) {
      return [];
    }
    const keywords = Array.from(tokens.keywords);
    const scored = traces
      .map((trace, index) => {
        const text = this.buildTraceSearchText(trace);
        const score = this.scoreTextAgainstKeywords(text, keywords);
        return { trace, score, index };
      })
      .filter((entry) => entry.score > 0);
    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    });
    return scored.slice(0, 25).map((entry) => entry.trace);
  }

  private mergeCollections<T>(
    primary: T[],
    secondary: T[],
    maxItems: number,
  ): T[] {
    if (!secondary?.length) {
      return primary.slice(0, maxItems);
    }
    const merged = [...primary];
    for (const item of secondary) {
      if (merged.length >= maxItems) {
        break;
      }
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
    return merged.slice(0, maxItems);
  }

  private buildRequestSearchText(request: any): string {
    if (!request || typeof request !== 'object') {
      return '';
    }
    const parts = [
      this.toSearchText(request.url),
      this.toSearchText(request.method),
      this.toSearchText(request.rid ?? request.requestRid),
      this.toSearchText(request.actionId ?? request.aid),
      this.toSearchText(request.status),
      this.toSearchText(request.key),
      this.toSearchText(request.body),
      this.toSearchText(request.params),
      this.toSearchText(request.query),
      this.toSearchText(request.respBody),
    ];
    return parts.filter(Boolean).join(' ');
  }

  private buildTraceSearchText(trace: any): string {
    if (!trace || typeof trace !== 'object') {
      return '';
    }
    const parts = [
      this.toSearchText(trace.requestRid ?? trace.rid),
      this.toSearchText(trace.actionId ?? trace.aid),
      this.toSearchText(trace.traceId ?? trace.tid),
      this.toSearchText(trace.data),
    ];
    return parts.filter(Boolean).join(' ');
  }

  private scoreTextAgainstKeywords(text: string, keywords: string[]): number {
    if (!text || !keywords?.length) {
      return 0;
    }
    const haystack = text.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      if (keyword && haystack.includes(keyword)) {
        score += 1;
      }
    }
    return score;
  }

  private toSearchText(value: any, max = 400): string {
    if (value === undefined || value === null) {
      return '';
    }
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      text = String(value);
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    text = text.toLowerCase();
    if (text.length > max) {
      return text.slice(0, max);
    }
    return text;
  }

  private rankTracesByHints<TTrace>(
    traces: TTrace[],
    tokens: HintTokens,
  ): TTrace[] {
    if (!tokens.hasDirectHints) {
      return [];
    }

    const scored = traces.map((trace, index) => {
      const events = this.normalizeTraceEvents((trace as any)?.data);
      const score = this.scoreTrace(events, tokens);
      return { trace, score, index };
    });

    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    });

    return scored
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.trace)
      .slice(0, 25);
  }

  private scoreTrace(events: TraceEventLike[], tokens: HintTokens): number {
    let score = 0;

    for (const event of events) {
      const file = this.normalizeFileHint(event?.file);
      const fn = typeof event?.fn === 'string' ? event.fn : undefined;
      const line = typeof event?.line === 'number' ? event.line : undefined;

      const fileMatch = file
        ? tokens.files.has(file) || tokens.fileBases.has(this.getBasename(file))
        : false;

      if (fileMatch) {
        score += 3;
      }

      if (line && tokens.lines.has(line)) {
        score += fileMatch ? 2 : 1;
      }

      if (fn && tokens.functions.has(fn.toLowerCase())) {
        score += 2;
      }
    }

    return score;
  }

  private scoreTraceSummaryEntry(
    entry: TraceSummaryEntry,
    tokens: HintTokens,
    requestIndex: RequestIndex,
  ): number {
    let score = this.scoreTextAgainstKeywords(
      entry.summary ?? '',
      Array.from(tokens.keywords),
    );
    score += this.scoreTrace(
      (entry.previewEvents ?? []) as TraceEventLike[],
      tokens,
    );
    if (entry.requestRid && requestIndex[entry.requestRid]) {
      score += 2;
    }
    if (entry.actionId) {
      score += 1;
    }
    return score;
  }

  private normalizeTraceEvents(data: any): TraceEventLike[] {
    if (Array.isArray(data)) {
      return data as TraceEventLike[];
    }
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? (parsed as TraceEventLike[]) : [];
      } catch {
        return [];
      }
    }
    if (data && typeof data === 'object' && Array.isArray((data as any).events)) {
      return (data as any).events as TraceEventLike[];
    }
    return [];
  }

  private extractHintTokens(messages: HintMessageParam[] = []): HintTokens {
    const files = new Set<string>();
    const fileBases = new Set<string>();
    const lines = new Set<number>();
    const functions = new Set<string>();
    const keywords = new Set<string>();

    for (const msg of messages ?? []) {
      const text = this.flattenMessageContent(msg?.content).trim();
      if (!text) continue;

      let match: RegExpExecArray | null;
      const fileRegex = /([\w./-]+\.[a-z0-9]{1,4})/gi;
      while ((match = fileRegex.exec(text))) {
        const normalized = this.normalizeFileHint(match[1]);
        files.add(normalized);
        const base = this.getBasename(normalized);
        if (base) fileBases.add(base);
      }

      const lineRegex = /line\s+(\d{1,6})/gi;
      while ((match = lineRegex.exec(text))) {
        lines.add(Number(match[1]));
      }

      const fnRegex = /\b([a-z]+[A-Z][\w]*)\b/g;
      while ((match = fnRegex.exec(text))) {
        functions.add(match[1].toLowerCase());
      }

      const words = text
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((part) => part.trim())
        .filter((part) => part.length >= 4);
      for (const word of words) {
        if (word.length) {
          keywords.add(word);
        }
      }
    }

    return {
      files,
      fileBases,
      lines,
      functions,
      keywords,
      hasDirectHints:
        Boolean(files.size || lines.size || functions.size || fileBases.size),
    };
  }

  private normalizeHintMessages(
    messages?: HintMessageParam[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const normalized: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (!messages?.length) {
      return normalized;
    }
    for (const msg of messages) {
      const content = this.flattenMessageContent(msg.content ?? msg);
      if (!content) {
        continue;
      }
      const role =
        msg.role === 'system' || msg.role === 'assistant' ? msg.role : 'user';
      normalized.push({ role, content });
    }
    return normalized;
  }

  private normalizeFileHint(value?: string | null): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private getBasename(file: string): string {
    const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    return idx >= 0 ? file.slice(idx + 1) : file;
  }

  private flattenMessageContent(content: any): string {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => this.flattenMessageContent(item?.text ?? item?.content ?? item))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content === 'object') {
      if (typeof content.text === 'string') {
        return content.text;
      }
      if (Array.isArray(content.text)) {
        return content.text.map((item: any) => this.flattenMessageContent(item)).join('\n');
      }
      if (typeof content.content === 'string') {
        return content.content;
      }
      if (Array.isArray(content.content)) {
        return content.content
          .map((item: any) => this.flattenMessageContent(item))
          .filter(Boolean)
          .join('\n');
      }
    }
    return '';
  }

  private resolveRequestId(value: any): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const rid =
      (value as any).rid ??
      (value as any).requestRid ??
      (value as any).request?.rid ??
      undefined;
    return typeof rid === 'string' ? rid : undefined;
  }

  private resolveTraceGroupId(value: any): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const requestRid =
      (value as any).requestRid ??
      (value as any).rid ??
      (value as any).request?.rid;
    const actionId = (value as any).actionId ?? (value as any).aid;
    const traceId = (value as any).traceId ?? (value as any).tid;
    const sessionId = (value as any).sessionId;
    return (
      (typeof requestRid === 'string' && requestRid) ||
      (typeof actionId === 'string' && actionId) ||
      (typeof traceId === 'string' && traceId) ||
      (typeof sessionId === 'string' && sessionId) ||
      undefined
    );
  }

  private sampleEvenly<T>(items: T[], maxItems: number): T[] {
    if (maxItems <= 0 || !items.length) {
      return [];
    }
    if (items.length <= maxItems) {
      return items.slice();
    }
    const result: T[] = [];
    const lastIndex = items.length - 1;
    for (let i = 0; i < maxItems; i++) {
      const idx = Math.round((i * lastIndex) / Math.max(1, maxItems - 1));
      if (!result.includes(items[idx])) {
        result.push(items[idx]);
      }
    }
    return result;
  }

  private tenantFilter<T extends Record<string, any>>(criteria: T): T & {
    tenantId: string;
  } {
    return { ...criteria, tenantId: this.tenant.tenantId };
  }
}

type TraceEventLike = Record<string, any>;

type HintTokens = {
  files: Set<string>;
  fileBases: Set<string>;
  lines: Set<number>;
  functions: Set<string>;
  keywords: Set<string>;
  hasDirectHints: boolean;
};

type HintMessageParam = {
  role?: string | null;
  content?: any;
};

type SessionDataset = {
  serialized: string;
  counts: Record<string, number>;
  chunks: DatasetChunk[];
};

type TraceDataLimitResult = {
  data: any;
  eventsUsed: number;
};

type CompactTraceEvent = {
  index: number;
  fn?: string;
  file?: string;
  line?: number;
  type?: string;
  message?: string;
  durationMs?: number;
};

type TraceSegmentPayload = {
  segmentIndex: number;
  summary: string;
  eventStart: number;
  eventEnd: number;
  eventCount: number;
  previewEvents: TracePreviewEvent[];
};

type TracePreviewEvent = {
  fn?: string;
  file?: string;
  line?: number;
  type?: string;
};

type TraceSummaryEntry = {
  groupId: string;
  requestRid?: string | null;
  actionId?: string | null;
  segmentIndex: number;
  eventStart: number;
  eventEnd: number;
  eventCount: number;
  summary: string;
  previewEvents?: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;
};

type ActionIndex = Record<string, ActionIndexEntry>;
type ActionIndexEntry = {
  actionId: string;
  label?: string;
  startedAt?: string;
  endedAt?: string;
};

type RequestIndex = Record<string, RequestIndexEntry>;
type RequestIndexEntry = {
  rid: string;
  method: string;
  url: string;
};

type TraceRefIndex = Record<string, { rid: string; codeRefs: CodeRef[] }>;

type CodeRef = {
  file: string;
  line?: number;
  fn?: string;
};

type DatasetChunk = {
  id: string;
  index: number;
  kind: DatasetChunkKind;
  text: string;
  length: number;
  metadata?: Record<string, any>;
};

type DatasetChunkKind =
  | 'overview'
  | 'counts'
  | 'action'
  | 'request'
  | 'dbChange'
  | 'email'
  | 'trace'
  | 'raw';

type UsageTotals = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

type ChatUsage = OpenAI.Chat.Completions.ChatCompletion['usage'];
