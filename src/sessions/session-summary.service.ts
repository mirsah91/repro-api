import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
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
import { TraceNode } from './schemas/trace-node.schema';
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
const TRACE_CHILD_EXPANSION_LIMIT = 150;
const TRACE_PARENT_EXPANSION_LIMIT = 150;
const FOCUS_CHUNK_EXTRA_LIMIT = 3;
const FOCUS_NODE_LIMIT = 80;
const CHAT_SYSTEM_PROMPT = [
  'You are the lead engineer fully responsible for this session’s codebase and runtime traces.',
  '',
  'Goal: answer with surgical precision using only evidence in this session. Never speculate or hedge ("maybe", "likely", etc.).',
  '',
  'Behavior rules:',
  '- Start by naming the exact endpoint (HTTP method + path) and controller file:line when available.',
  '- Map request bodies to controller arguments when the trace lacks explicit args, and map response bodies to the return value when no explicit result is captured.',
  '- Surface only the functions, arguments, responses, and side effects that answer the user’s question; do not dump unrelated traces.',
  '- If the user targets a nested helper, include that helper plus the nearest parent/child functions and offer to expand on it only if the user asks.',
  '',
  'When answering:',
  '1. List every relevant function call in execution order with name, file:line, args (JSON), return value (JSON), and any DB/external operations it performs.',
  '2. Provide JSON blocks for request/response/params/query whenever they inform the answer or substitute for missing args/results.',
  '3. Clearly describe DB operations or external calls with the function/file that invoked them.',
  '4. Summarize the core logic in concise paragraphs after the structured details.',
  '5. If additional focused functions are available, end the answer with “Need details on <fn list>?” referencing up to three remaining names.',
  '6. If data is missing, state "Not captured in trace/body/query" instead of guessing.',
  '',
  'Formatting guidelines:',
  '- Use fenced JSON for arguments, request bodies, responses, or params.',
  '- Include `file.ts:123` exactly when both file and line exist; otherwise say "location unavailable".',
  '- Never invent filenames, functions, or values.',
  '',
  'Tone:',
  '- Speak as the code owner: confident, technical, zero filler.',
  '- Answer only what the user asked; do not ask follow-up questions unless the user explicitly requests more detail.',
  '',
  'Remember: request body ⇔ controller args, response body ⇔ return value, unless explicit trace data overrides it.',
  'Do not include unrelated traces, extra commentary, or additional follow-up questions.'
].join('');


@Injectable()
export class SessionSummaryService {
  private readonly logger = new Logger(SessionSummaryService.name);
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
    @InjectModel(TraceNode.name)
    private readonly traceNodes: Model<TraceNode>,
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
      completion.choices?.[0]?.message?.content?.trim() ??
      'No summary returned.';
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
      const datasetFocusIds = new Set(dataset.focus?.chunkIds ?? []);
      const datasetFocusFunctions = dataset.focus?.functions ?? [];

      let selectedChunks: DatasetChunk[];
      let enforcedFocusIds: Set<string> = datasetFocusIds;

      if (datasetFocusIds.size) {
        selectedChunks = this.ensureFocusChunkContext(
          dataset.chunks,
          datasetFocusIds,
          CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT,
        );
      } else {
        const derivedFocus = this.determineFocusChunkIds(
          dataset.chunks,
          hintTokens,
        );
        enforcedFocusIds = derivedFocus;
        selectedChunks = this.selectDatasetChunks(
          dataset.chunks,
          hintTokens,
          CHAT_MAX_DATASET_CHUNKS,
          derivedFocus,
        );
        selectedChunks = this.expandChunksWithRelated(
          this.appendFocusChunks(
            selectedChunks,
            dataset.chunks,
            derivedFocus,
            CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT,
          ),
          dataset.chunks,
          Math.min(
            dataset.chunks.length,
            CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT + 4,
          ),
        );
      }

      const datasetContext = this.composeChunkContext(
        selectedChunks,
        dataset.chunks.length,
      );

      const llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: CHAT_SYSTEM_PROMPT,
        },
      ];

      const focusFollowups =
        datasetFocusFunctions.length > 0
          ? datasetFocusFunctions
          : this.collectFocusFunctionNamesFromChunks(selectedChunks);
      if (focusFollowups.length) {
        llmMessages.push({
          role: 'system',
          content: [
            'Focused functions with full context:',
            focusFollowups.join(', '),
            'After answering, append "Need details on <fn list>?" referencing up to three of these names if additional detail could help.',
          ].join(' '),
        });
      }

      llmMessages.push(...conversation);
      llmMessages.push({
        role: 'system',
        content: datasetContext,
      });

      this.logger.debug('chatSession LLM payload', {
        sessionId,
        messageCount: llmMessages.length,
        datasetChunkCount: dataset.chunks.length,
      });
      this.logger.verbose('chatSession LLM messages', {
        sessionId,
        messages: llmMessages,
      });

      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: llmMessages,
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
    const hintTokens = this.extractHintTokens(opts?.hintMessages ?? []);
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
    const focusEntries = await this.fetchFocusTraceEntries(
      sessionId,
      hintTokens,
      FOCUS_NODE_LIMIT,
    );
    const chunkBuildResult = this.buildDatasetChunks(
      payload,
      jsonSnapshot,
      actionIndex,
      requestIndex,
      traceIndex,
      retrievalEntries,
      focusEntries,
    );
    const chunks = chunkBuildResult.chunks;
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
      focus: {
        chunkIds: Array.from(chunkBuildResult.focusChunkIds),
        functions: Array.from(chunkBuildResult.focusFunctions),
      },
    };
  }

  private async collectCursor<T, R = T>(
    cursor: any,
    transform?: (item: T) => R,
  ): Promise<R[]> {
    const out: R[] = [];
    try {
      for await (const item of cursor) {
        const value = transform ? transform(item) : (item as R);
        out.push(value);
      }
    } finally {
      if (!cursor.closed) {
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
        rawId &&
        typeof rawId === 'object' &&
        typeof rawId.toString === 'function'
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
    focusEntries: TraceSummaryEntry[] = [],
  ): {
    chunks: DatasetChunk[];
    focusChunkIds: Set<string>;
    focusFunctions: Set<string>;
  } {
    const chunks: DatasetChunk[] = [];
    const seenChunkIds = new Set<string>();
    const focusChunkIds = new Set<string>();
    const focusFunctions = new Set<string>();
    const timelineContext: TimelineContext = {
      dbChanges: payload.timeline.dbChanges ?? [],
      emails: payload.timeline.emails ?? [],
    };

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

    const focusChunkIdSet = new Set(
      focusEntries
        .map((entry) => entry.chunkId)
        .filter((id): id is string => Boolean(id)),
    );
    const combinedEntries = this.mergeTraceEntriesWithFocus(
      retrievalEntries,
      focusEntries,
    );

    combinedEntries.forEach((entry, idx) => {
      const chunkId = `traceSummary:${entry.groupId}:${entry.segmentIndex}:${idx}`;
      const isFocus = entry.__focus === true || focusChunkIdSet.has(entry.chunkId ?? '');
      pushChunk({
        id: chunkId,
        kind: 'trace',
        metadata: {
          rid: entry.requestRid ?? undefined,
          actionId: entry.actionId ?? undefined,
          chunkId: entry.chunkId ?? undefined,
          parentChunkId: entry.parentChunkId ?? undefined,
          depth: entry.depth ?? undefined,
          files: this.collectFilesForTraceEntry(entry),
          focus: isFocus || undefined,
        },
        text: this.formatTraceSummaryEntryChunk(
          entry,
          requestIndex,
          actionIndex,
          timelineContext,
        ),
      });
      if (isFocus) {
        focusChunkIds.add(chunkId);
        const fn =
          entry.functionName ??
          entry.nodeDetail?.functionName ??
          undefined;
        if (fn) {
          focusFunctions.add(fn);
        }
      }
    });

    this.splitRawSnapshot(jsonSnapshot).forEach((text, part) => {
      pushChunk({
        id: `raw:${part + 1}`,
        kind: 'raw',
        metadata: { part: part + 1 },
        text,
      });
    });

    return { chunks, focusChunkIds, focusFunctions };
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
    const label = this.toShortText(
      action.label ?? action.type ?? 'action',
      120,
    );
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
    const to = Array.isArray(email.to) ? email.to.join(', ') : (email.to ?? '');
    const cc = Array.isArray(email.cc) ? email.cc.join(', ') : (email.cc ?? '');
    const bcc = Array.isArray(email.bcc)
      ? email.bcc.join(', ')
      : (email.bcc ?? '');
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
          const file = segment.previewEvents?.find(
            (evt: any) => evt.file,
          )?.file;
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
        [
          '## Raw JSON Snapshot',
          '```json',
          snapshot.slice(i, i + partSize),
          '```',
        ].join('\n'),
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
      const refs =
        Array.isArray(trace.codeRefs) && trace.codeRefs.length
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
    const addRef = (
      file?: string | null,
      line?: number | null,
      fn?: string | null,
    ) => {
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

  private normalizeEndpointPath(path: string): string {
    if (!path) {
      return '';
    }
    try {
      const parsed = new URL(path, 'https://dummy');
      return (parsed.pathname ?? '/').toLowerCase();
    } catch {
      return path.startsWith('/') ? path.toLowerCase() : `/${path.toLowerCase()}`;
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
      const bodyPreview = this.previewJson(request.body, 800);
      const respPreview = this.previewJson(request.respBody, 800);
      const paramsPreview = this.previewJson(request.params, 400);
      const queryPreview = this.previewJson(request.query, 400);
      const headersPreview = this.previewJson(request.headers, 400);
      map[rid] = {
        rid,
        method: (request.method ?? 'GET').toUpperCase(),
        url: this.describeUrl(request.url),
        actionId: request.actionId ?? request.aid ?? null,
        bodyPreview,
        responsePreview: respPreview,
        paramsPreview,
        queryPreview,
        headersPreview,
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
    timeline: TimelineContext,
  ): string {
    const rid = entry.requestRid ?? 'n/a';
    const actionId = entry.actionId ?? 'n/a';
    const node = entry.nodeDetail;
    const requestRef = this.lookupRequest(requestIndex, rid);
    const actionRef = this.lookupAction(actionIndex, actionId);
    const lineage = (entry.lineageTrail ?? [])
      .filter((trail) => trail.relation === 'parent')
      .map((trail, idx) => {
        const file = trail.filePath
          ? `${trail.filePath}${trail.lineNumber ? `:${trail.lineNumber}` : ''}`
          : '';
        return `  - [${idx + 1}] ${trail.functionName ?? 'fn'} ${file} (depth ${trail.depth})`;
      })
      .join('\n');
    const children = (entry.childSummaries ?? [])
      .map((child, idx) => {
        const file = child.filePath
          ? `${child.filePath}${child.lineNumber ? `:${child.lineNumber}` : ''}`
          : '';
        return `  - [${idx + 1}] ${child.functionName ?? 'fn'} ${file} (depth ${child.depth})`;
      })
      .join('\n');
    const relatedDbChangesList = this.findRelatedDbChanges(
      entry,
      timeline.dbChanges,
    );
    const relatedDbChanges = relatedDbChangesList
      .map(
        (change, idx) =>
          `  - [${idx + 1}] ${change.summary ?? this.toShortText(change.op ?? 'operation', 80)}`,
      )
      .join('\n');
    const relatedEmailsList = this.findRelatedEmails(entry, timeline.emails);
    const relatedEmails = relatedEmailsList
      .map(
        (email, idx) =>
          `  - [${idx + 1}] ${this.describeEmailSummary(email)}`,
      )
      .join('\n');
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
    const metadataSection =
      node?.metadata && node.metadata.length
        ? node.metadata
            .slice(0, 10)
            .map(
              (item, idx) =>
                `  - [${idx + 1}] ${item.key}: ${item.value ?? 'n/a'}`,
            )
            .join('\n')
        : undefined;
    const argsSource =
      node?.argsPreview ??
      requestRef?.bodyPreview ??
      requestRef?.paramsPreview ??
      requestRef?.queryPreview ??
      requestRef?.headersPreview;
    const argsLabel = node?.argsPreview
      ? 'Function arguments'
      : requestRef?.bodyPreview
        ? 'Request body (used as arguments)'
        : requestRef?.paramsPreview
          ? 'Request params (used as arguments)'
          : requestRef?.queryPreview
            ? 'Request query (used as arguments)'
            : requestRef?.headersPreview
              ? 'Request headers (fallback arguments)'
              : null;
    const argsBlock =
      argsSource && argsLabel
        ? [argsLabel + ':', '```json', argsSource, '```'].join('\n')
        : undefined;
    const resultSource = node?.resultPreview ?? requestRef?.responsePreview;
    const resultLabel = node?.resultPreview
      ? 'Return value'
      : requestRef?.responsePreview
        ? 'Response body (used as return value)'
        : null;
    const resultBlock =
      resultSource && resultLabel
        ? [resultLabel + ':', '```json', resultSource, '```'].join('\n')
        : undefined;
    const effectiveFn =
      entry.functionName ??
      node?.functionName ??
      'function name unavailable';
    const effectiveFile = entry.filePath ?? node?.filePath ?? 'location unavailable';
    const effectiveLine =
      entry.lineNumber ??
      (typeof node?.lineNumber === 'number' ? node.lineNumber : undefined);

    return [
      `## Trace Function Segment`,
      `chunkId: ${entry.chunkId ?? 'legacy'}`,
      entry.chunkKind ? `kind: ${entry.chunkKind}` : undefined,
      typeof entry.depth === 'number' ? `depth: ${entry.depth}` : undefined,
      `function: ${effectiveFn} (${effectiveFile}${effectiveLine ? `:${effectiveLine}` : ''})`,
      node?.durationMs ? `duration: ${node.durationMs}ms` : undefined,
      `requestRid: ${rid}`,
      `request: ${requestRef ? `${requestRef.method} ${requestRef.url}` : 'unknown'}`,
      `actionId: ${actionId}`,
      `actionLabel: ${actionRef?.label ?? 'unknown action'}`,
      actionRef?.startedAt ? `actionWindow: ${actionRef.startedAt} → ${actionRef.endedAt ?? 'open'}` : undefined,
      `events: ${entry.eventCount} (segment ${entry.segmentIndex})`,
      lineage ? `ancestors:\n${lineage}` : undefined,
      children ? `children:\n${children}` : undefined,
      relatedDbChanges ? `related DB changes:\n${relatedDbChanges}` : undefined,
      relatedEmails ? `related emails:\n${relatedEmails}` : undefined,
      metadataSection ? `metadata:\n${metadataSection}` : undefined,
      requestRef?.bodyPreview
        ? ['request body:', '```json', requestRef.bodyPreview, '```'].join('\n')
        : undefined,
      requestRef?.responsePreview
        ? ['response body:', '```json', requestRef.responsePreview, '```'].join(
            '\n',
          )
        : undefined,
      requestRef?.paramsPreview
        ? ['request params:', '```json', requestRef.paramsPreview, '```'].join(
            '\n',
          )
        : undefined,
      requestRef?.queryPreview
        ? ['request query:', '```json', requestRef.queryPreview, '```'].join(
            '\n',
          )
        : undefined,
      requestRef?.headersPreview
        ? ['request headers:', '```json', requestRef.headersPreview, '```'].join(
            '\n',
          )
        : undefined,
      argsBlock,
      resultBlock,
      `summary:`,
      entry.summary,
      preview ? `preview:\n${preview}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private findRelatedDbChanges(
    entry: TraceSummaryEntry,
    changes: any[],
  ): any[] {
    if (!changes?.length) {
      return [];
    }
    const rid = entry.requestRid ?? null;
    const actionId = entry.actionId ?? null;
    return changes
      .filter((change) => {
        const matchesRid =
          rid &&
          (change?.requestRid ?? change?.rid ?? change?.meta?.requestRid) ===
            rid;
        const matchesAction =
          actionId &&
          (change?.actionId ?? change?.aid ?? change?.meta?.actionId) ===
            actionId;
        return matchesRid || matchesAction;
      })
      .slice(0, 3)
      .map((change) => ({
        ...change,
        summary: this.formatDbChangeSummaryInline(change),
      }));
  }

  private findRelatedEmails(entry: TraceSummaryEntry, emails: any[]): any[] {
    if (!emails?.length) {
      return [];
    }
    const rid = entry.requestRid ?? null;
    const actionId = entry.actionId ?? null;
    return emails
      .filter((email) => {
        const matchesRid =
          rid &&
          (email?.requestRid ?? email?.rid ?? email?.meta?.requestRid) === rid;
        const matchesAction =
          actionId &&
          (email?.actionId ?? email?.aid ?? email?.meta?.actionId) === actionId;
        return matchesRid || matchesAction;
      })
      .slice(0, 3);
  }

  private formatDbChangeSummaryInline(change: any): string {
    if (!change || typeof change !== 'object') {
      return 'db change (unknown)';
    }
    const collection = change.collection ?? change.table ?? 'collection';
    const op = (change.op ?? change.operation ?? 'operation').toUpperCase();
    const rid = change.requestRid ?? change.rid ?? 'n/a';
    const dur =
      typeof change.durMs === 'number' && Number.isFinite(change.durMs)
        ? `${Math.round(change.durMs)}ms`
        : null;
    const query = this.previewJson(
      change.query ?? change.filter ?? change.criteria,
      280,
    );
    const result = this.previewJson(change.resultMeta, 280);
    const before = this.previewJson(change.before, 200);
    const after = this.previewJson(change.after, 200);
    const detailLines = [
      `${collection}.${op} (request ${rid}${dur ? `, ${dur}` : ''})`,
      query ? `    query: ${query}` : null,
      before ? `    before: ${before}` : null,
      after ? `    after: ${after}` : null,
      result ? `    result: ${result}` : null,
    ].filter(Boolean);
    const error =
      change.error && typeof change.error === 'object'
        ? this.previewJson(change.error, 200)
        : change.error
          ? String(change.error)
          : null;
    if (error) {
      detailLines.push(`    error: ${error}`);
    }
    return detailLines.join('\n');
  }

  private describeEmailSummary(email: any): string {
    if (!email || typeof email !== 'object') {
      return '(unknown email)';
    }
    const subject = this.toShortText(email.subject ?? '(no subject)', 120);
    const toList = Array.isArray(email.to)
      ? email.to.map((addr: any) => addr?.email ?? addr).filter(Boolean)
      : email.to
        ? [email.to]
        : [];
    const recipients = toList.length ? toList.join(', ') : 'recipients unknown';
    const status =
      typeof email.statusCode === 'number'
        ? `status=${email.statusCode}`
        : null;
    const dur =
      typeof email.durMs === 'number' && Number.isFinite(email.durMs)
        ? `${Math.round(email.durMs)}ms`
        : null;
    return [subject, recipients, status, dur]
      .filter(Boolean)
      .join(' | ');
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

  private collectFilesForTraceEntry(entry: TraceSummaryEntry): string[] {
    const files = new Set<string>();
    if (entry.filePath && entry.filePath.trim().length) {
      files.add(entry.filePath.trim().toLowerCase());
    }
    this.collectFilesFromPreview(entry.previewEvents).forEach((file) =>
      files.add(file),
    );
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
    focusChunkIds?: Set<string>,
  ): DatasetChunk[] {
    if (!chunks?.length) {
      return [];
    }
    if (chunks.length <= maxChunks || maxChunks <= 0) {
      return chunks;
    }

    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const forcedIds = focusChunkIds ?? new Set<string>();

    const scored = chunks.map((chunk) => ({
      chunk,
      score: this.scoreDatasetChunk(chunk, tokens),
      forced: forcedIds.has(chunk.id),
    }));

    scored.sort((a, b) => {
      if (b.score === a.score) {
        return a.chunk.index - b.chunk.index;
      }
      return b.score - a.score;
    });

    const selected = scored.slice(0, maxChunks);
    const selectedIds = new Set(selected.map((entry) => entry.chunk.id));

    const missingForced: typeof scored = [];
    for (const id of forcedIds) {
      if (!selectedIds.has(id)) {
        const chunk = chunkById.get(id);
        if (chunk) {
          missingForced.push({
            chunk,
            score: Number.MAX_SAFE_INTEGER,
            forced: true,
          });
        }
      }
    }

    selected.push(...missingForced);

    const hasSignal = selected.some((item) => item.score > 0);
    if (!hasSignal) {
      return chunks.slice(0, Math.min(chunks.length, maxChunks));
    }

    const effectiveMax = Math.min(
      chunks.length,
      maxChunks + Math.min(missingForced.length, FOCUS_CHUNK_EXTRA_LIMIT),
    );

    selected.sort((a, b) => {
      if (a.forced && !b.forced) return -1;
      if (b.forced && !a.forced) return 1;
      if (b.score === a.score) {
        return a.chunk.index - b.chunk.index;
      }
      return b.score - a.score;
    });

    const trimmed = selected.slice(0, effectiveMax);
    trimmed.sort((a, b) => a.chunk.index - b.chunk.index);
    return trimmed.map((item) => item.chunk);
  }

  private mergeTraceEntriesWithFocus(
    baseEntries: TraceSummaryEntry[],
    focusEntries: TraceSummaryEntry[],
  ): Array<TraceSummaryEntry & { __focus?: boolean }> {
    const map = new Map<string, TraceSummaryEntry & { __focus?: boolean }>();
    const combine = (
      entry: TraceSummaryEntry,
      isFocus: boolean,
    ): void => {
      const key = `${entry.groupId}:${entry.segmentIndex}`;
      if (!map.has(key)) {
        map.set(key, { ...entry, __focus: isFocus || undefined });
      } else if (isFocus) {
        const existing = map.get(key);
        if (existing) {
          existing.__focus = true;
        }
      }
    };
    baseEntries?.forEach((entry) => combine(entry, false));
    focusEntries?.forEach((entry) => combine(entry, true));
    return Array.from(map.values());
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
      if (typeof line === 'number' && line >= 0 && text.includes(`:${line}`)) {
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
      const path = this.normalizeEndpointPath(String(chunk.metadata.url));
      if (tokens.endpoints.has(path)) {
        score += 5;
      }
    }
    if (chunk.metadata?.method) {
      const method = String(chunk.metadata.method).toUpperCase();
      if (tokens.httpMethods.has(method)) {
        score += 2;
      }
    }
    if (chunk.metadata?.rid) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.rid),
        keywordList,
      );
      if (tokens.requestIds.has(String(chunk.metadata.rid).toLowerCase())) {
        score += 4;
      }
    }
    if (chunk.metadata?.actionId) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.actionId),
        keywordList,
      );
      if (
        tokens.actionIds.has(String(chunk.metadata.actionId).toLowerCase())
      ) {
        score += 4;
      }
    }
    if (Array.isArray(chunk.metadata?.files)) {
      for (const file of chunk.metadata.files) {
        const normalized = this.normalizeFileHint(file);
        if (
          tokens.files.has(normalized) ||
          tokens.fileBases.has(this.getBasename(normalized))
        ) {
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
      if (meta.focus) {
        seen.add(chunk.id);
      }
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

  private appendFocusChunks(
    selected: DatasetChunk[],
    allChunks: DatasetChunk[],
    focusIds: Set<string>,
    limit: number,
  ): DatasetChunk[] {
    if (!focusIds?.size) {
      return selected;
    }
    const out = [...selected];
    const seen = new Set(selected.map((chunk) => chunk.id));
    const chunkById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));

    for (const id of focusIds) {
      if (seen.has(id)) continue;
      const chunk = chunkById.get(id);
      if (chunk) {
        out.push(chunk);
        seen.add(id);
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  private ensureFocusChunkContext(
    allChunks: DatasetChunk[],
    focusIds: Set<string>,
    limit: number,
  ): DatasetChunk[] {
    if (!focusIds?.size) {
      return allChunks.slice(0, limit);
    }
    const chunkById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
    const selected: DatasetChunk[] = [];
    const seen = new Set<string>();
    const relatedKeys = new Set<string>();

    const addChunk = (chunk?: DatasetChunk) => {
      if (!chunk || seen.has(chunk.id)) {
        return;
      }
      selected.push(chunk);
      seen.add(chunk.id);
      const meta = chunk.metadata ?? {};
      if (meta.rid) relatedKeys.add(`rid:${meta.rid}`);
      if (meta.actionId) relatedKeys.add(`action:${meta.actionId}`);
    };

    focusIds.forEach((id) => addChunk(chunkById.get(id)));

    if (selected.length < limit) {
      for (const chunk of allChunks) {
        if (selected.length >= limit) break;
        if (seen.has(chunk.id)) continue;
        const meta = chunk.metadata ?? {};
        if (
          (meta.rid && relatedKeys.has(`rid:${meta.rid}`)) ||
          (meta.actionId && relatedKeys.has(`action:${meta.actionId}`))
        ) {
          addChunk(chunk);
        }
      }
    }

    if (selected.length < limit) {
      for (const chunk of allChunks) {
        if (selected.length >= limit) break;
        if (seen.has(chunk.id)) continue;
        addChunk(chunk);
      }
    }

    return selected;
  }

  private determineFocusChunkIds(
    chunks: DatasetChunk[],
    tokens: HintTokens,
    extraIds?: Set<string>,
  ): Set<string> {
    const focus = new Set<string>(extraIds ?? []);
    if (!chunks?.length) {
      return focus;
    }
    const ridSet = new Set(Array.from(tokens.requestIds).map((id) => id));
    const actionSet = new Set(Array.from(tokens.actionIds).map((id) => id));
    const endpointSet = new Set(Array.from(tokens.endpoints));
    const methodSet = new Set(Array.from(tokens.httpMethods));

    for (const chunk of chunks) {
      const meta = chunk.metadata ?? {};
      if (meta.focus) {
        focus.add(chunk.id);
        continue;
      }
      const rid =
        typeof meta.rid === 'string' ? meta.rid.toLowerCase() : undefined;
      if (rid && ridSet.has(rid)) {
        focus.add(chunk.id);
        continue;
      }
      const actionId =
        typeof meta.actionId === 'string'
          ? meta.actionId.toLowerCase()
          : undefined;
      if (actionId && actionSet.has(actionId)) {
        focus.add(chunk.id);
        continue;
      }
      const urlPath =
        typeof meta.url === 'string'
          ? this.normalizeEndpointPath(meta.url)
          : undefined;
      const method =
        typeof meta.method === 'string'
          ? meta.method.toUpperCase()
          : undefined;
      if (urlPath && endpointSet.has(urlPath)) {
        focus.add(chunk.id);
        continue;
      }
      if (urlPath && endpointSet.size) {
        for (const endpoint of endpointSet) {
          if (urlPath.startsWith(endpoint)) {
            focus.add(chunk.id);
            break;
          }
        }
        if (focus.has(chunk.id)) continue;
      }
      if (
        method &&
        methodSet.has(method) &&
        chunk.kind === 'request' &&
        endpointSet.size
      ) {
        focus.add(chunk.id);
      }
    }

    return focus;
  }

  private collectFocusFunctionNamesFromChunks(
    chunks: DatasetChunk[],
  ): string[] {
    const names = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.kind !== 'trace') {
        continue;
      }
      const text = chunk.text || '';
      const match = text.match(/function:\s+([^\n]+)/i);
      if (match?.[1]) {
        const name = match[1].trim();
        if (name && !name.toLowerCase().includes('function name unavailable')) {
          names.add(name);
        }
      }
    }
    return Array.from(names);
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
      'Chunks preserve logical entities such as requests, actions, changes and traces.',
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
    if (meta.files?.length)
      parts.push(`files=${meta.files.slice(0, 2).join(',')}`);
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
    const scopedTraces = this.mergeCollections(baseTraces, keywordTraces, 25);
    const traceRids = new Set(
      scopedTraces
        .map((trace: any) => this.resolveRequestId(trace))
        .filter((rid): rid is string => Boolean(rid)),
    );

    const prioritizedRequestIds = new Set(
      prioritizedTraces
        .map((trace: any) => this.resolveRequestId(trace))
        .filter((rid): rid is string => Boolean(rid)),
    );

    const baseRequests = prioritizedRequestIds.size
      ? this.composePrioritizedRequests(requests, prioritizedRequestIds, tokens)
      : this.sampleEvenly(requests, 12);
    const keywordRequests = this.filterRequestsByKeywords(requests, tokens);
    const mergedRequests = this.mergeCollections(
      baseRequests,
      keywordRequests,
      20,
    );
    const scopedRequests = this.ensureRequestsForTraceRids(
      mergedRequests,
      requests,
      traceRids,
      24,
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
        result.push(
          this.buildTracePlaceholder(trace, 'trace_budget_exhausted'),
        );
        continue;
      }

      const limited = this.limitTracePayload(trace, remainingEvents);
      remainingEvents = Math.max(0, remainingEvents - limited.eventsUsed);
      included += 1;

      const groupId = this.resolveTraceGroupId(limited.payload);
      const segmentEntries = groupId ? (summaries.get(groupId) ?? []) : [];
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

    const nodeEntries = await this.findTraceEntriesFromNodes(
      sessionId,
      tokens,
      limit,
    );
    for (const entry of nodeEntries) {
      const key = `${entry.groupId}:${entry.segmentIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }

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

    const selected = scored
      .filter((item) => item.score > 0)
      .slice(0, limit)
      .map((item) => item.entry);

    const expanded = await this.expandTraceSummaryEntries(sessionId, selected);
    return this.attachTraceNodeDetails(sessionId, expanded);
  }

  private async fetchFocusTraceEntries(
    sessionId: string,
    tokens: HintTokens,
    limit: number,
  ): Promise<TraceSummaryEntry[]> {
    let seeds: TraceNodeDetail[] = [];
    if (tokens.functions.size || tokens.files.size) {
      const orFilters: any[] = [];
      if (tokens.functions.size) {
        const fnList = Array.from(tokens.functions).map(
          (fn) => new RegExp(`^${fn}$`, 'i'),
        );
        orFilters.push({ functionName: { $in: fnList } });
      }
      if (tokens.files.size) {
        const fileList = Array.from(tokens.files).map(
          (file) => new RegExp(this.escapeRegex(file), 'i'),
        );
        orFilters.push({ filePath: { $in: fileList } });
      }
      const query =
        orFilters.length === 1
          ? this.tenantFilter({
              sessionId,
              ...orFilters[0],
            })
          : this.tenantFilter({
              sessionId,
              $or: orFilters,
            });
      seeds = await this.traceNodes
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean()
        .exec();
    }
    if (!seeds?.length && tokens.requestIds.size) {
      seeds = await this.traceNodes
        .find(
          this.tenantFilter({
            sessionId,
            requestRid: { $in: Array.from(tokens.requestIds) },
          }),
        )
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean()
        .exec();
    }
    if (!seeds?.length && tokens.endpoints.size) {
      const endpointRegexes = Array.from(tokens.endpoints).map(
        (endpoint) => new RegExp(this.escapeRegex(endpoint), 'i'),
      );
      const matchingRequests = await this.requests
        .find(
          this.tenantFilter({
            sessionId,
            url: { $in: endpointRegexes },
          }),
          { rid: 1 },
        )
        .limit(limit * 2)
        .lean()
        .exec();
      const ridList = matchingRequests
        .map((req: any) => req?.rid)
        .filter((rid): rid is string => Boolean(rid));
      if (ridList.length) {
        seeds = await this.traceNodes
          .find(
            this.tenantFilter({
              sessionId,
              requestRid: { $in: ridList },
            }),
          )
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean()
          .exec();
      }
    }
    if (!seeds?.length) {
      return [];
    }

    const cache = new Map<string, TraceNodeDetail>();
    for (const node of seeds) {
      cache.set(node.chunkId, node as TraceNodeDetail);
    }

    const parentIds = await this.expandTraceNodeIds(
      sessionId,
      seeds
        .map((node) => node.parentChunkId)
        .filter((id): id is string => Boolean(id)),
      'parent',
      TRACE_PARENT_EXPANSION_LIMIT,
      cache,
    );
    const childIds = await this.expandTraceNodeIds(
      sessionId,
      seeds
        .flatMap((node) => node.childChunkIds ?? [])
        .filter((id): id is string => Boolean(id)),
      'child',
      TRACE_CHILD_EXPANSION_LIMIT,
      cache,
    );

    const chunkIdSet = new Set<string>();
    seeds.forEach((node) => {
      if (node.chunkId) chunkIdSet.add(node.chunkId);
    });
    parentIds.forEach((id) => chunkIdSet.add(id));
    childIds.forEach((id) => chunkIdSet.add(id));

    const chunkIds = Array.from(chunkIdSet);
    if (!chunkIds.length) {
      return [];
    }

    const summariesMap = await this.fetchTraceSummariesByChunkIds(
      sessionId,
      chunkIds,
    );
    const entries: TraceSummaryEntry[] = [];
    for (const id of chunkIds) {
      const entry = summariesMap.get(id);
      if (entry) {
        const nodeDetail = cache.get(id);
        entries.push({
          ...entry,
          nodeDetail,
          __focus: true,
        } as TraceSummaryEntry & { __focus?: boolean });
      }
    }
    return entries;
  }

  private async expandTraceNodeIds(
    sessionId: string,
    initialIds: string[],
    direction: 'parent' | 'child',
    limit: number,
    cache: Map<string, TraceNodeDetail>,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    let frontier = initialIds.filter(Boolean);
    while (frontier.length && result.size < limit) {
      await this.loadTraceNodes(sessionId, frontier, cache);
      const next: string[] = [];
      for (const id of frontier) {
        if (!id || result.has(id)) continue;
        const node = cache.get(id);
        if (!node) continue;
        result.add(id);
        if (direction === 'parent' && node.parentChunkId) {
          next.push(node.parentChunkId);
        } else if (direction === 'child' && node.childChunkIds?.length) {
          for (const child of node.childChunkIds) {
            if (child) next.push(child);
          }
        }
        if (result.size >= limit) {
          break;
        }
      }
      frontier = next;
    }
    return result;
  }

  private async loadTraceNodes(
    sessionId: string,
    chunkIds: string[],
    cache: Map<string, TraceNodeDetail>,
  ): Promise<void> {
    const missing = Array.from(
      new Set(
        chunkIds.filter(
          (id) => id && !cache.has(id),
        ),
      ),
    );
    if (!missing.length) {
      return;
    }
    const docs = await this.traceNodes
      .find(
        this.tenantFilter({
          sessionId,
          chunkId: { $in: missing },
        }),
      )
      .lean()
      .exec();
    for (const doc of docs ?? []) {
      if (doc?.chunkId) {
        cache.set(doc.chunkId, doc as TraceNodeDetail);
      }
    }
  }

  private async findTraceEntriesFromNodes(
    sessionId: string,
    tokens: HintTokens,
    limit: number,
  ): Promise<TraceSummaryEntry[]> {
    const functionHints = Array.from(tokens.functions).filter(Boolean);
    const fileHints = Array.from(
      new Set([...tokens.files, ...tokens.fileBases]),
    ).filter(Boolean);
    if (!functionHints.length && !fileHints.length) {
      return [];
    }
    const orFilters: any[] = [];
    if (functionHints.length) {
      orFilters.push({ functionName: { $in: functionHints } });
    }
    if (fileHints.length) {
      const regexes = fileHints.map(
        (hint) => new RegExp(this.escapeRegex(hint), 'i'),
      );
      orFilters.push({ filePath: { $in: regexes } });
    }
    const query = this.tenantFilter({
      sessionId,
      ...(orFilters.length
        ? orFilters.length === 1
          ? orFilters[0]
          : { $or: orFilters }
        : {}),
    });
    const nodeDocs = await this.traceNodes
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit * 4)
      .lean()
      .exec();
    if (!nodeDocs?.length) {
      return [];
    }
    const chunkIds = Array.from(
      new Set(
        nodeDocs
          .map((doc) => doc?.chunkId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (!chunkIds.length) {
      return [];
    }
    const summaries = await this.fetchTraceSummariesByChunkIds(
      sessionId,
      chunkIds,
    );
    const nodeMap = new Map<string, TraceNodeDetail>();
    nodeDocs.forEach((doc) => {
      if (doc?.chunkId) {
        nodeMap.set(doc.chunkId, doc as TraceNodeDetail);
      }
    });
    const entries: TraceSummaryEntry[] = [];
    for (const chunkId of chunkIds) {
      const entry = summaries.get(chunkId);
      if (entry) {
        entries.push({
          ...entry,
          nodeDetail: nodeMap.get(chunkId),
        });
      }
      if (entries.length >= limit) {
        break;
      }
    }
    return entries;
  }

  private async attachTraceNodeDetails(
    sessionId: string,
    entries: TraceSummaryEntry[],
  ): Promise<TraceSummaryEntry[]> {
    if (!entries.length) {
      return entries;
    }
    const chunkIds = Array.from(
      new Set(
        entries
          .map((entry) => entry.chunkId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (!chunkIds.length) {
      return entries;
    }
    const docs = await this.traceNodes
      .find(
        this.tenantFilter({
          sessionId,
          chunkId: { $in: chunkIds },
        }),
      )
      .lean()
      .exec();
    const map = new Map<string, TraceNodeDetail>();
    for (const doc of docs ?? []) {
      if (doc?.chunkId) {
        map.set(doc.chunkId, doc as TraceNodeDetail);
      }
    }
    return entries.map((entry) => ({
      ...entry,
      nodeDetail: entry.chunkId ? map.get(entry.chunkId) : undefined,
    }));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async expandTraceSummaryEntries(
    sessionId: string,
    seeds: TraceSummaryEntry[],
  ): Promise<TraceSummaryEntry[]> {
    if (!seeds.length) {
      return [];
    }

    const appendedIds = new Set<string>();
    seeds.forEach((entry) => {
      if (entry.chunkId) {
        appendedIds.add(entry.chunkId);
      }
    });

    const childCandidates: string[] = [];
    const parentCandidates: string[] = [];
    for (const entry of seeds) {
      const parentId = entry.parentChunkId;
      if (
        parentId &&
        !appendedIds.has(parentId) &&
        parentCandidates.length < TRACE_PARENT_EXPANSION_LIMIT * seeds.length
      ) {
        parentCandidates.push(parentId);
      }
      const childIds = (entry.childChunkIds ?? []).filter(Boolean);
      for (const childId of childIds.slice(0, TRACE_CHILD_EXPANSION_LIMIT)) {
        if (
          !appendedIds.has(childId) &&
          childCandidates.length <
            TRACE_CHILD_EXPANSION_LIMIT * seeds.length
        ) {
          childCandidates.push(childId);
        }
      }
    }

    const [childDocs, parentDocs] = await Promise.all([
      this.fetchTraceSummariesByChunkIds(sessionId, childCandidates),
      this.fetchTraceSummariesByChunkIds(sessionId, parentCandidates),
    ]);

    const expanded: TraceSummaryEntry[] = [];
    for (const entry of seeds) {
      expanded.push(entry);
      const parentId = entry.parentChunkId;
      if (parentId) {
        const parent = parentDocs.get(parentId);
        if (parent?.chunkId && !appendedIds.has(parent.chunkId)) {
          expanded.push(parent);
          appendedIds.add(parent.chunkId);
        }
      }
      const childIds = (entry.childChunkIds ?? []).filter(Boolean);
      for (const childId of childIds.slice(0, TRACE_CHILD_EXPANSION_LIMIT)) {
        const child = childDocs.get(childId);
        if (child?.chunkId && !appendedIds.has(child.chunkId)) {
          expanded.push(child);
          appendedIds.add(child.chunkId);
        }
      }
    }

    return expanded;
  }

  private async fetchTraceSummariesByChunkIds(
    sessionId: string,
    chunkIds: string[],
  ): Promise<Map<string, TraceSummaryEntry>> {
    const map = new Map<string, TraceSummaryEntry>();
    if (!chunkIds?.length) {
      return map;
    }
    const unique = Array.from(new Set(chunkIds.filter(Boolean)));
    if (!unique.length) {
      return map;
    }

    const docs = await this.traceSummaries
      .find(
        this.tenantFilter({
          sessionId,
          chunkId: { $in: unique },
        }),
      )
      .limit(unique.length)
      .lean()
      .exec();

    for (const doc of docs ?? []) {
      if (doc?.chunkId) {
        map.set(doc.chunkId, doc as TraceSummaryEntry);
      }
    }

    return map;
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

  private scoreTraceSegment(
    entry: TraceSummaryEntry,
    tokens: HintTokens,
  ): number {
    if (!tokens.hasDirectHints) {
      return entry.segmentIndex < TRACE_SEGMENT_LIMIT_PER_TRACE ? 1 : 0;
    }
    let score = 0;
    const summaryText = entry.summary?.toLowerCase?.() ?? '';
    const functionName = entry.functionName?.toLowerCase?.() ?? '';
    const filePath = entry.filePath?.toLowerCase?.() ?? '';
    const fileBase = filePath ? this.getBasename(filePath).toLowerCase() : '';
    const lineageTrail = entry.lineageTrail ?? [];
    const childSummaries = entry.childSummaries ?? [];
    const lineageFunctions = lineageTrail
      .map((trail) => trail.functionName?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const childFunctions = childSummaries
      .map((child) => child.functionName?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const lineageFiles = lineageTrail
      .map((trail) => trail.filePath?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const childFiles = childSummaries
      .map((child) => child.filePath?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const lineageFileBases = lineageFiles.map((file) =>
      this.getBasename(file).toLowerCase(),
    );
    const childFileBases = childFiles.map((file) =>
      this.getBasename(file).toLowerCase(),
    );
    const lineageLines = lineageTrail
      .map((trail) =>
        typeof trail.lineNumber === 'number' && Number.isFinite(trail.lineNumber)
          ? Math.floor(trail.lineNumber)
          : null,
      )
      .filter((line): line is number => line !== null);
    const childLines = childSummaries
      .map((child) =>
        typeof child.lineNumber === 'number' && Number.isFinite(child.lineNumber)
          ? Math.floor(child.lineNumber)
          : null,
      )
      .filter((line): line is number => line !== null);
    const lineNumber =
      typeof entry.lineNumber === 'number' && Number.isFinite(entry.lineNumber)
        ? Math.floor(entry.lineNumber)
        : null;
    const searchCorpus = [summaryText, functionName, filePath, fileBase].join(' ');

    const includes = (haystack: string, needle?: string) =>
      needle ? haystack.includes(needle) : false;

    tokens.functions.forEach((fn) => {
      const needle = fn?.toLowerCase();
      if (!needle) return;
      if (includes(functionName, needle)) {
        score += 6;
      } else if (childFunctions.some((name) => includes(name, needle))) {
        score += 3;
      } else if (lineageFunctions.some((name) => includes(name, needle))) {
        score += 2;
      } else if (summaryText.includes(needle)) {
        score += 1;
      }
    });

    tokens.files.forEach((file) => {
      const needle = file?.toLowerCase();
      if (!needle) return;
      if (includes(filePath, needle)) {
        score += 5;
      } else if (includes(fileBase, needle)) {
        score += 4;
      } else if (childFiles.some((name) => includes(name, needle))) {
        score += 2;
      } else if (lineageFiles.some((name) => includes(name, needle))) {
        score += 1;
      }
    });

    tokens.fileBases.forEach((base) => {
      const needle = base?.toLowerCase();
      if (!needle) return;
      if (includes(fileBase, needle)) {
        score += 4;
      } else if (includes(filePath, needle)) {
        score += 3;
      } else if (childFileBases.some((name) => includes(name, needle))) {
        score += 2;
      } else if (lineageFileBases.some((name) => includes(name, needle))) {
        score += 1;
      }
    });

    tokens.lines.forEach((line) => {
      if (typeof line !== 'number' || !Number.isFinite(line)) {
        return;
      }
      if (lineNumber === line) {
        score += 3;
      } else if (childLines.includes(line)) {
        score += 2;
      } else if (lineageLines.includes(line)) {
        score += 1;
      }
    });

    tokens.keywords.forEach((keyword) => {
      const needle = keyword?.toLowerCase();
      if (needle && searchCorpus.includes(needle)) {
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
    events?: Array<{
      fn?: string | null;
      file?: string | null;
      line?: number | null;
      type?: string | null;
    }>,
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
      note: 'Trace events chunked to respect model context limits. Each segment summarizes a chronological block of events.',
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

  private buildTracePlaceholder<TTrace>(trace: TTrace, reason: string): TTrace {
    if (!trace || typeof trace !== 'object') {
      return trace;
    }
    const events = this.normalizeTraceEvents((trace as any)?.data);
    const placeholder = {
      omitted: true,
      reason,
      totalEvents: events.length,
      note: 'Trace omitted from prompt to stay within model context window. Provide more specific hints to focus on the right trace.',
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
    const seen = new Set(merged);
    for (const item of secondary) {
      if (merged.length >= maxItems) {
        break;
      }
      if (!seen.has(item)) {
        merged.push(item);
        seen.add(item);
      }
    }
    return merged.slice(0, maxItems);
  }

  private ensureRequestsForTraceRids<TRequest>(
    selected: TRequest[],
    allRequests: TRequest[],
    traceRids: Set<string>,
    maxItems: number,
  ): TRequest[] {
    if (!traceRids.size) {
      return selected.slice(0, maxItems);
    }
    const byRid = new Map<string, TRequest>();
    selected.forEach((request) => {
      const rid = this.resolveRequestId(request);
      if (rid && !byRid.has(rid)) {
        byRid.set(rid, request);
      }
    });

    const needed: TRequest[] = [];
    if (needed.length < traceRids.size) {
      for (const rid of traceRids) {
        if (byRid.has(rid)) {
          continue;
        }
        const match = allRequests.find(
          (request) => this.resolveRequestId(request) === rid,
        );
        if (match) {
          needed.push(match);
          byRid.set(rid, match);
        }
        if (needed.length >= 16) {
          break;
        }
      }
    }

    const combined = [...selected, ...needed];
    if (combined.length <= maxItems) {
      return combined;
    }
    const seen = new Set<string>();
    const trimmed: TRequest[] = [];
    for (const request of combined) {
      const rid = this.resolveRequestId(request);
      const key = rid ?? JSON.stringify(request);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      trimmed.push(request);
      if (trimmed.length >= maxItems) {
        break;
      }
    }
    return trimmed;
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
    if (data && typeof data === 'object' && Array.isArray(data.events)) {
      return data.events as TraceEventLike[];
    }
    return [];
  }

  private extractHintTokens(messages: HintMessageParam[] = []): HintTokens {
    const files = new Set<string>();
    const fileBases = new Set<string>();
    const lines = new Set<number>();
    const functions = new Set<string>();
    const keywords = new Set<string>();
    const requestIds = new Set<string>();
    const actionIds = new Set<string>();
    const endpoints = new Set<string>();
    const httpMethods = new Set<string>();

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

      const endpointRegex =
        /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+([/][^\s]+)/gi;
      while ((match = endpointRegex.exec(text))) {
        httpMethods.add(match[1].toUpperCase());
        endpoints.add(this.normalizeEndpointPath(match[2]));
      }

      const ridRegex =
        /\b(?:rid|requestId|request|req)\s*[:=#-]?\s*([a-z0-9_-]{6,})\b/gi;
      while ((match = ridRegex.exec(text))) {
        requestIds.add(match[1].toLowerCase());
      }

      const hexIdRegex = /\b[a-f0-9]{16,}\b/gi;
      while ((match = hexIdRegex.exec(text))) {
        requestIds.add(match[0].toLowerCase());
      }

      const actionRegex =
        /\b(?:actionId|action)\s*[:=#-]?\s*([a-z0-9_-]{4,})\b/gi;
      while ((match = actionRegex.exec(text))) {
        actionIds.add(match[1].toLowerCase());
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
      requestIds,
      actionIds,
      endpoints,
      httpMethods,
      hasDirectHints: Boolean(
        files.size ||
          lines.size ||
          functions.size ||
          fileBases.size ||
          requestIds.size ||
          actionIds.size ||
          endpoints.size,
      ),
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
        .map((item) =>
          this.flattenMessageContent(item?.text ?? item?.content ?? item),
        )
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content === 'object') {
      if (typeof content.text === 'string') {
        return content.text;
      }
      if (Array.isArray(content.text)) {
        return content.text
          .map((item: any) => this.flattenMessageContent(item))
          .join('\n');
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
      value.rid ?? value.requestRid ?? value.request?.rid ?? undefined;
    return typeof rid === 'string' ? rid : undefined;
  }

  private resolveTraceGroupId(value: any): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const requestRid = value.requestRid ?? value.rid ?? value.request?.rid;
    const actionId = value.actionId ?? value.aid;
    const traceId = value.traceId ?? value.tid;
    const sessionId = value.sessionId;
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

  private tenantFilter<T extends Record<string, any>>(
    criteria: T,
  ): T & {
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
  requestIds: Set<string>;
  actionIds: Set<string>;
  endpoints: Set<string>;
  httpMethods: Set<string>;
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
  focus?: {
    chunkIds: string[];
    functions: string[];
  };
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

type TimelineContext = {
  dbChanges: any[];
  emails: any[];
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
  chunkId?: string | null;
  parentChunkId?: string | null;
  chunkKind?: string | null;
  depth?: number | null;
  childChunkIds?: string[];
  lineagePath?: string | null;
  lineageTrail?: Array<{
    chunkId: string;
    functionName?: string | null;
    filePath?: string | null;
    lineNumber?: number | null;
    depth: number;
    relation: 'self' | 'parent' | 'child';
  }>;
  childSummaries?: Array<{
    chunkId: string;
    functionName?: string | null;
    filePath?: string | null;
    lineNumber?: number | null;
    depth: number;
  }>;
  functionName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  previewEvents?: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;
  nodeDetail?: TraceNodeDetail;
  __focus?: boolean;
};

type TraceNodeDetail = {
  chunkId: string;
  groupId?: string;
  requestRid?: string | null;
  actionId?: string | null;
  batchIndex?: number | null;
  parentChunkId?: string | null;
  childChunkIds?: string[];
  functionName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  depth?: number | null;
  argsPreview?: string | null;
  resultPreview?: string | null;
  durationMs?: number | null;
  eventStart?: number | null;
  eventEnd?: number | null;
  sampleEvents?: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;
  metadata?: Array<{ key: string; value: string }>;
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
  actionId?: string | null;
  bodyPreview?: string;
  responsePreview?: string;
  paramsPreview?: string;
  queryPreview?: string;
  headersPreview?: string;
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
