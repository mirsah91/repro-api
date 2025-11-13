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
import {
  SessionChatMessage,
  SessionChatRole,
} from './schemas/session-chat.schema';
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
const CHAT_MAX_DATASET_CHUNKS = 10;
const CHUNK_SUMMARY_MAX_TOKENS = 450;
const SUMMARY_CHUNK_LIMIT = 40;
const TRACE_CHILD_EXPANSION_LIMIT = 150;
const TRACE_PARENT_EXPANSION_LIMIT = 150;
const FOCUS_CHUNK_EXTRA_LIMIT = 3;
const FOCUS_NODE_LIMIT = 80;
const CHUNK_STRING_ROOT_LIMIT = 600;
const CHUNK_STRING_NESTED_LIMIT = 320;
const CHUNK_ARRAY_ROOT_LIMIT = 12;
const CHUNK_ARRAY_NESTED_LIMIT = 6;
const CHUNK_OBJECT_ROOT_LIMIT = 18;
const CHUNK_OBJECT_NESTED_LIMIT = 10;
const EMBEDDING_CANDIDATE_LIMIT = 120;
const EMBEDDING_CHUNK_CHAR_LIMIT = 2000;
const EMBEDDING_HINT_BOOST = 0.05;
const CODE_REF_CONTEXT_LIMIT = 20;
const CHAT_SYSTEM_PROMPT = [
  'You are the on-call engineer answering questions about a single debugging session.',
  'Context will only contain data from the actions, requests, traces, and changes collections—never cite other sources or invent events.',
  'Honor the target collection noted in the context: describe only actions when the target is actions, requests (plus entryPoint fn/file:line) when the target is requests, traces and their call graph when the target is traces, and DB operations when the target is changes.',
  'When traces are provided, treat them as authoritative call graphs: describe the parent function with file:line plus args/returns, and mention at most three notable child calls—anything deeper should be pushed into the follow-up suggestions.',
  'When requests are provided, always cite method, URL, status, and entryPoint.fn file.ts:line before summarizing any attached traces.',
  'When actions are provided, focus on the action label, timing, and whether it triggered requests or DB work only if the data explicitly links it.',
  'When changes are provided, document the collection, operation, key filter/update fields, and result metadata, tying them back to the triggering identifiers if present.',
  'If information is missing, say "Not available in context." Do not speculate.',
  'If forwardSuggestions are listed in the context, end the answer with `Follow-ups: suggestion; ...` using that exact text, treating those suggestions as the place to explore the highlighted child functions.',
  'Never mention that a planning model was used; just answer confidently from the JSON context.',
].join('\n');
const SYSTEM_PROMPT = [
  'You convert natural-language debugging questions into a single MongoDB query plan targeting exactly one of four collections.',
  '',
  'SCHEMAS (use these exact field names):',
  '- actions: { sessionId, actionId, label, tStart, tEnd, hasReq, hasDb, error, ui }',
  '- requests: { sessionId, actionId, rid, method, url, key, status, t, durMs, headers, body, params, query, respBody, entryPoint:{ fn, file, line, functionType }, codeRefs:[{ fn, file, line }] }',
  '- traces: { sessionId, requestRid, actionId?, batchIndex, codeRefs:[{ fn, file, line }], data, metadata }',
  '- changes: { sessionId, actionId, collection, op, query:{ filter, update, projection, options, pipeline, bulk }, before, after, pk, resultMeta, durMs, error, t }',
  '',
  'RELATIONS:',
  '- actions.actionId == requests.actionId',
  '- changes.actionId == actions.actionId',
  '- traces.requestRid == requests.rid',
  '- requests.entryPoint.fn is the root function for traces when no explicit trace hint is provided.',
  '',
  'OUTPUT (JSON only):',
  '{',
  '  "target": "actions|requests|traces|changes",',
  '  "limit": <int>,',
  '  "mongo": {',
  '    "collection": "actions|requests|traces|changes",',
  '    "filter": { ... valid Mongo filter using the schema fields ... },',
  '    "limit"?: <int>,',
  '    "sort"?: { "<field>": 1|-1 }',
  '  },',
  '  "functionName"?: string,',
  '  "action"?: { "actionId"?: string, "label"?: string, "labelContains"?: string, "hasReq"?: boolean, "hasDb"?: boolean, "error"?: boolean },',
  '  "request"?: { "rid"?: string, "status"?: number },',
  '  "endpoint"?: { "method"?: string, "url"?: string, "key"?: string },',
  '  "entryPoint"?: { "fn"?: string, "file"?: string, "line"?: number },',
  '  "change"?: { "collection"?: string, "op"?: string },',
  '  "reason": string',
  '}',
  '',
  'RULES:',
  '- Use only the fields listed in the schemas; do NOT invent aliases like urlFragment or functionName.',
  '- When matching endpoint text with multiple words (e.g. "dispatch shipment"), split into words and require ALL of them on url using $and of case-insensitive regexes, e.g.:',
  '  { "$and": [ { "url": { "$regex": "dispatch", "$options": "i" } }, { "url": { "$regex": "shipment", "$options": "i" } } ] }',
  '- Do NOT merge the words into a single regex like "dispatch.*shipment".',
  '- When matching functions in traces, use codeRefs.fn. For requests, use entryPoint.fn.',
  '- Always include concrete filters; never leave mongo.filter empty.',
  '- Function/file/line/trace questions → target "traces".',
  '- HTTP endpoint/body/response questions → target "requests".',
  '- UI/user-action questions → target "actions".',
  '- Database collection/op/filter/update questions → target "changes".',
  '- Echo any detected function name verbatim in functionName and/or entryPoint.fn.',
  '- Respond with JSON only.',
].join('\\n');

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
    @InjectModel(SessionChatMessage.name)
    private readonly chatMessages: Model<SessionChatMessage>,
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
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }

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

    const countsPromise = this.fetchSessionCounts(sessionId);
    const client = this.ensureClient();
    const model =
      this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';

    const conversation = this.normalizeHintMessages(opts?.messages);
    const { history, latestUser } =
      this.splitConversationForPrompt(conversation);
    const questionText =
      latestUser?.content?.toString()?.trim() ||
      conversation[conversation.length - 1]?.content?.toString()?.trim() ||
      'Explain the most relevant details for this session.';

    let reply = '';
    let datasetContext = '';
    let usage: UsageTotals | undefined;

    try {
      const plan = await this.buildChatQueryPlan(
        questionText,
        conversation,
        sessionDoc,
      );
      console.log('plan --->', JSON.stringify(plan, null, 2));

      const execution = await this.executeChatQueryPlan(
        sessionId,
        plan,
        opts?.messages ?? [],
      );

      datasetContext = this.composeChatExecutionContext(sessionDoc, execution);

      const llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          ...history,
          {
            role: 'user',
            content: [datasetContext, '', `Question: ${questionText}`].join(
              '\n',
            ),
          },
        ];

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

      if (execution.forwardSuggestions.length) {
        const followupLine = `Follow-ups: ${execution.forwardSuggestions.join(
          '; ',
        )}`;
        if (!reply.toLowerCase().includes('follow-ups')) {
          reply = [reply, followupLine].filter(Boolean).join('\n\n');
        }
      }
    } catch (err: any) {
      const message =
        err?.message ??
        'Failed to generate a chat response with the configured OpenAI model.';
      throw new InternalServerErrorException(message);
    }

    const counts = await countsPromise;

    await this.persistChatMessages(sessionId, opts?.appId, [
      datasetContext ? { role: 'system', content: datasetContext } : undefined,
      questionText ? { role: 'user', content: questionText } : undefined,
      reply ? { role: 'assistant', content: reply } : undefined,
    ]);

    return {
      sessionId,
      reply,
      model,
      counts,
      usage,
    };
  }

  private async buildChatQueryPlan(
    question: string,
    conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    sessionDoc: Session,
  ): Promise<ChatQueryPlan> {
    const fallback = this.buildFallbackChatQueryPlan(question);
    const trimmedQuestion = question?.trim();
    if (!trimmedQuestion) {
      return fallback;
    }
    try {
      const client = this.ensureClient();
      const builderModel =
        this.config.get<string>('OPENAI_QUERY_MODEL')?.trim() ||
        this.config.get<string>('OPENAI_MODEL')?.trim() ||
        'gpt-4o-mini';

      // Build the exact JSON payload the model will see as the "user" message.
      const userPayload = {
        conversation: this.buildConversationSummary(conversation),
        latestQuestion: trimmedQuestion,
        session: {
          sessionId: String(sessionDoc._id),
          appId: String(sessionDoc.appId),
        },
      };

      const completion = await client.chat.completions.create({
        model: builderModel,
        temperature: 0,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(userPayload, null, 2) },
        ],
      });

      const raw = completion.choices?.[0]?.message?.content?.trim();
      if (!raw) {
        return fallback;
      }
      const parsed = this.tryParseJson<any>(raw);
      if (!parsed) {
        return fallback;
      }
      return this.normalizeChatQueryPlan(parsed, fallback);
    } catch (err: any) {
      this.logger.warn(
        'LLM query-plan builder failed; using fallback.',
        err?.message ?? err,
      );
      return fallback;
    }
  }

  private buildConversationSummary(
    conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    limit = 8,
  ): Array<{ role: string; content: string }> {
    if (!conversation?.length) {
      return [];
    }
    return conversation
      .map((msg) => ({
        role: msg.role ?? 'user',
        content: this.flattenMessageContent(msg.content ?? ''),
      }))
      .filter((entry) => entry.content && entry.content.trim().length)
      .slice(-limit);
  }

  private normalizeChatQueryPlan(
    parsed: any,
    fallback: ChatQueryPlan,
  ): ChatQueryPlan {
    const mongo =
      this.normalizePlanMongo(parsed?.mongo) ?? fallback.mongo ?? undefined;
    const target =
      this.parseChatCollection(parsed?.target) ??
      mongo?.collection ??
      fallback.target ??
      'requests';
    const result: ChatQueryPlan = {
      target,
      limit:
        typeof parsed?.limit === 'number' && Number.isFinite(parsed.limit)
          ? parsed.limit
          : fallback.limit,
      reason:
        typeof parsed?.reason === 'string' && parsed.reason.trim().length
          ? parsed.reason.trim()
          : fallback.reason,
      mongo,
    };

    const functionName =
      typeof parsed?.functionName === 'string'
        ? parsed.functionName.trim()
        : undefined;
    if (functionName) {
      result.functionName = functionName;
    } else if (fallback.functionName) {
      result.functionName = fallback.functionName;
    }

    result.action = this.normalizePlanAction(parsed?.action) ?? fallback.action;
    result.request =
      this.normalizePlanRequest(parsed?.request) ?? fallback.request;
    result.endpoint =
      this.normalizePlanEndpoint(parsed?.endpoint) ?? fallback.endpoint;
    result.entryPoint =
      this.normalizePlanEntryPoint(
        parsed?.entryPoint ?? parsed?.request?.entryPoint,
      ) ?? fallback.entryPoint;
    result.change = this.normalizePlanChange(parsed?.change) ?? fallback.change;

    const includeValues =
      (Array.isArray(parsed?.include) && parsed.include) ||
      (Array.isArray(parsed?.includes) && parsed.includes) ||
      undefined;
    if (includeValues?.length) {
      const includeSet = new Set<ChatCollection>();
      includeValues.forEach((item: any) => {
        const parsedTarget = this.parseChatCollection(item);
        if (parsedTarget && parsedTarget !== target) {
          includeSet.add(parsedTarget);
        }
      });
      if (includeSet.size) {
        result.include = Array.from(includeSet);
      }
    } else if (fallback.include?.length) {
      result.include = fallback.include;
    }

    result.limit = this.resolvePlanLimit(result);
    return result;
  }

  private parseChatCollection(value: any): ChatCollection | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'actions' ||
      normalized === 'requests' ||
      normalized === 'traces' ||
      normalized === 'changes'
    ) {
      return normalized as ChatCollection;
    }
    return undefined;
  }

  private normalizePlanAction(raw: any): ChatPlanAction | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const action: ChatPlanAction = {};
    if (typeof raw.actionId === 'string' && raw.actionId.trim()) {
      action.actionId = raw.actionId.trim();
    }
    if (typeof raw.label === 'string' && raw.label.trim()) {
      action.label = raw.label.trim();
    }
    if (typeof raw.labelContains === 'string' && raw.labelContains.trim()) {
      action.labelContains = raw.labelContains.trim();
    }
    if (typeof raw.hasReq === 'boolean') {
      action.hasReq = raw.hasReq;
    }
    if (typeof raw.hasDb === 'boolean') {
      action.hasDb = raw.hasDb;
    }
    if (typeof raw.error === 'boolean') {
      action.error = raw.error;
    }
    return Object.keys(action).length ? action : undefined;
  }

  private normalizePlanRequest(raw: any): ChatPlanRequest | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const request: ChatPlanRequest = {};
    if (typeof raw.rid === 'string' && raw.rid.trim()) {
      request.rid = raw.rid.trim();
    }
    if (typeof raw.status === 'number' && Number.isFinite(raw.status)) {
      request.status = Math.round(raw.status);
    }
    return Object.keys(request).length ? request : undefined;
  }

  private normalizePlanEndpoint(raw: any): ChatPlanEndpoint | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const endpoint: ChatPlanEndpoint = {};
    if (typeof raw.method === 'string' && raw.method.trim()) {
      endpoint.method = raw.method.trim();
    }
    if (typeof raw.urlFragment === 'string' && raw.urlFragment.trim()) {
      endpoint.urlFragment = raw.urlFragment.trim();
    }
    if (typeof raw.exactUrl === 'string' && raw.exactUrl.trim()) {
      endpoint.exactUrl = raw.exactUrl.trim();
    }
    if (typeof raw.key === 'string' && raw.key.trim()) {
      endpoint.key = raw.key.trim();
    }
    return Object.keys(endpoint).length ? endpoint : undefined;
  }

  private normalizePlanEntryPoint(raw: any): ChatPlanEntryPoint | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const entryPoint: ChatPlanEntryPoint = {};
    if (typeof raw.fn === 'string' && raw.fn.trim()) {
      entryPoint.fn = raw.fn.trim();
    }
    if (typeof raw.file === 'string' && raw.file.trim()) {
      entryPoint.file = raw.file.trim();
    }
    if (typeof raw.line === 'number' && Number.isFinite(raw.line)) {
      entryPoint.line = Math.round(raw.line);
    }
    return Object.keys(entryPoint).length ? entryPoint : undefined;
  }

  private normalizePlanChange(raw: any): ChatPlanChange | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const change: ChatPlanChange = {};
    if (typeof raw.collection === 'string' && raw.collection.trim()) {
      change.collection = raw.collection.trim();
    }
    if (typeof raw.op === 'string' && raw.op.trim()) {
      change.op = raw.op.trim();
    }
    return Object.keys(change).length ? change : undefined;
  }

  private normalizePlanMongo(raw: any): ChatPlanMongoQuery | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const mongo: ChatPlanMongoQuery = {};
    const collection = this.parseChatCollection(raw.collection);
    if (collection) {
      mongo.collection = collection;
    }
    if (
      typeof raw.limit === 'number' &&
      Number.isFinite(raw.limit) &&
      raw.limit > 0
    ) {
      mongo.limit = Math.min(8, Math.max(1, Math.floor(raw.limit)));
    }
    const normalizedFilter = this.normalizeFilterAliases(raw.filter);
    const filter = this.sanitizePlanFilter(normalizedFilter);
    if (filter) {
      mongo.filter = filter;
    }
    const sort = this.sanitizePlanSort(raw.sort);
    if (sort) {
      mongo.sort = sort;
    }
    if (!mongo.collection && !mongo.filter && !mongo.limit && !mongo.sort) {
      return undefined;
    }
    return mongo;
  }

  private buildFallbackChatQueryPlan(question: string): ChatQueryPlan {
    const normalized = (question ?? '').toLowerCase();
    let target: ChatCollection = 'requests';
    if (
      /database|db|query|insert|update|delete|mongo|collection/.test(normalized)
    ) {
      target = 'changes';
    } else if (/trace|stack|function|call|parent|child|line/.test(normalized)) {
      target = 'traces';
    } else if (/action|click|button|tap|gesture/.test(normalized)) {
      target = 'actions';
    } else if (/request|endpoint|http|route|status/.test(normalized)) {
      target = 'requests';
    }
    const [fnCandidate] = this.extractFunctionCandidates(question);
    return {
      target,
      functionName: fnCandidate,
      reason: 'fallback',
    };
  }

  private resolvePlanLimit(plan: ChatQueryPlan): number {
    const defaults: Record<ChatCollection, number> = {
      actions: 5,
      requests: 4,
      traces: 4,
      changes: 5,
    };
    const mongoLimit = plan.mongo?.limit;
    if (typeof mongoLimit === 'number' && Number.isFinite(mongoLimit)) {
      return Math.min(8, Math.max(1, Math.floor(mongoLimit)));
    }
    const raw = Number(plan.limit);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(8, Math.max(1, Math.floor(raw)));
    }
    return defaults[plan.target] ?? 4;
  }

  private pickPlanMongo(
    plan: ChatQueryPlan,
    collection: ChatCollection,
  ): ChatPlanMongoQuery | undefined {
    if (!plan.mongo) {
      return undefined;
    }
    if (plan.target !== collection) {
      return undefined;
    }
    if (plan.mongo.collection && plan.mongo.collection !== collection) {
      return undefined;
    }
    return plan.mongo;
  }

  private buildTenantCriteria(
    base: Record<string, any>,
    ...filters: Array<Record<string, any> | undefined>
  ): Record<string, any> {
    const primary = { ...base, tenantId: this.tenant.tenantId };
    const extras = filters.filter(
      (filter): filter is Record<string, any> =>
        this.hasFilterContent(filter),
    );
    if (!extras.length) {
      return primary;
    }
    return { $and: [primary, ...extras] };
  }

  private sanitizePlanFilter(
    filter: any,
    depth = 0,
  ): Record<string, any> | undefined {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      return undefined;
    }
    if (depth > 8) {
      return undefined;
    }
    const allowedOperators = new Set([
      '$and',
      '$or',
      '$in',
      '$nin',
      '$eq',
      '$ne',
      '$gt',
      '$gte',
      '$lt',
      '$lte',
      '$regex',
      '$options',
      '$all',
      '$elemMatch',
      '$exists',
      '$size',
    ]);
    const sanitized: Record<string, any> = {};
    for (const [rawKey, rawValue] of Object.entries(filter)) {
      if (typeof rawKey !== 'string') {
        continue;
      }
      const key = rawKey.trim();
      if (!key.length) {
        continue;
      }
      if (key.toLowerCase() === '$where') {
        continue;
      }
      if (key.startsWith('$') && !allowedOperators.has(key)) {
        continue;
      }
      const value = this.sanitizePlanValue(rawValue, depth + 1);
      if (value === undefined) {
        continue;
      }
      sanitized[key] = value;
    }
    return Object.keys(sanitized).length ? sanitized : undefined;
  }

  private normalizeFilterAliases(filter: any): any {
    if (Array.isArray(filter)) {
      return filter.map((item) => this.normalizeFilterAliases(item));
    }
    if (!filter || typeof filter !== 'object') {
      return filter;
    }
    const normalized: Record<string, any> = {};
    for (const [rawKey, rawValue] of Object.entries(filter)) {
      if (rawKey === 'urlFragment' && typeof rawValue === 'string') {
        normalized.url = {
          ...(typeof normalized.url === 'object' ? normalized.url : {}),
          $regex: rawValue,
          $options: 'i',
        };
        continue;
      }
      normalized[rawKey] = this.normalizeFilterAliases(rawValue);
    }
    return normalized;
  }

  private sanitizePlanValue(value: any, depth: number): any {
    if (value === null) {
      return null;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (typeof value === 'string' && value.length > 600) {
        return value.slice(0, 600);
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (depth > 8) {
        return undefined;
      }
      const sanitized = value
        .map((item) => this.sanitizePlanValue(item, depth + 1))
        .filter((item) => item !== undefined);
      return sanitized.length ? sanitized : undefined;
    }
    if (typeof value === 'object') {
      return this.sanitizePlanFilter(value, depth + 1);
    }
    return undefined;
  }

  private sanitizePlanSort(
    sort: any,
  ): Record<string, 1 | -1> | undefined {
    if (!sort || typeof sort !== 'object') {
      return undefined;
    }
    const result: Record<string, 1 | -1> = {};
    for (const [rawKey, rawValue] of Object.entries(sort)) {
      if (typeof rawKey !== 'string') {
        continue;
      }
      const key = rawKey.trim();
      if (!key.length) {
        continue;
      }
      const dir = Number(rawValue);
      if (dir === 1 || dir === -1) {
        result[key] = dir;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }

  private hasFilterContent(
    filter?: Record<string, any>,
  ): filter is Record<string, any> {
    return Boolean(filter && Object.keys(filter).length);
  }

  private async executeChatQueryPlan(
    sessionId: string,
    plan: ChatQueryPlan,
    hintMessages: HintMessageParam[],
  ): Promise<ChatPlanExecution> {
    const collections: ChatPlanCollections = {};
    const forwardSeed: ChatForwardSeed = {};
    const limit = this.resolvePlanLimit(plan);
    plan.limit = limit;

    if (plan.target === 'actions') {
      const branchPlan = this.pickPlanMongo(plan, 'actions');
      const filter = this.buildActionFilter(plan);
      const query = this.buildTenantCriteria(
        { sessionId },
        branchPlan?.filter,
        filter,
      );
      const actionDocs = await this.actions
        .find(query)
        .sort(branchPlan?.sort ?? { tStart: 1 })
        .limit(branchPlan?.limit ?? limit)
        .lean()
        .exec();
      const actionResults = actionDocs.map((doc) => this.sanitize(doc));
      collections.actions = actionResults;

      if (actionResults.length) {
        const actionIds = Array.from(
          new Set(
            actionResults
              .map((action: any) => action?.actionId)
              .filter((id): id is string => Boolean(id)),
          ),
        );
        if (actionIds.length) {
          const relatedRequests = await this.requests
            .find(
              this.buildTenantCriteria({
                sessionId,
                actionId: { $in: actionIds },
              }),
            )
            .sort({ t: 1 })
            .limit(limit * 3)
            .lean()
            .exec();
          forwardSeed.requests = relatedRequests.map((doc) =>
            this.sanitize(hydrateRequestDoc(doc)),
          );
        }
      }
    } else if (plan.target === 'requests') {
      const branchPlan = this.pickPlanMongo(plan, 'requests');
      const filter = this.buildRequestFilter(plan);
      const query = this.buildTenantCriteria(
        { sessionId },
        branchPlan?.filter,
        filter,
      );

      console.log('query --->', JSON.stringify(query, null, 2))
      const requestDocs = await this.requests
        .find(query)
        .sort(branchPlan?.sort ?? { t: 1 })
        .limit(branchPlan?.limit ?? limit)
        .lean()
        .exec();
      const hydratedRequests = requestDocs.map((doc) =>
        this.sanitize(hydrateRequestDoc(doc)),
      );
      collections.requests = hydratedRequests;

      const fnSet = new Set<string>();
      const requestRids = new Set<string>();
      hydratedRequests.forEach((req) => {
        const entryFn =
          (req?.entryPoint?.fn as string | undefined)?.trim() ||
          plan.functionName;
        if (entryFn) {
          fnSet.add(entryFn);
        }
        if (typeof req?.rid === 'string' && req.rid) {
          requestRids.add(req.rid);
        }
      });
      if (plan.functionName && !fnSet.size) {
        fnSet.add(plan.functionName);
      }

      if (fnSet.size || requestRids.size) {
        const traceDocs = await this.fetchTracesForFunctions(
          sessionId,
          Array.from(fnSet),
          Array.from(requestRids),
          limit,
          hintMessages,
          undefined,
          undefined,
        );
        collections.traces = traceDocs;
        forwardSeed.childFunctions = this.collectTraceChildFunctions(
          traceDocs,
          fnSet,
        );
      }
    } else if (plan.target === 'traces') {
      const branchPlan = this.pickPlanMongo(plan, 'traces');
      const traces = await this.fetchTracesForPlan(
        sessionId,
        plan,
        branchPlan?.limit ?? limit,
        hintMessages,
        branchPlan?.filter,
        branchPlan?.sort,
      );
      collections.traces = traces;

      const requestRids = Array.from(
        new Set(
          traces
            .map((trace: any) => trace?.requestRid)
            .filter((rid): rid is string => Boolean(rid)),
        ),
      );
      if (requestRids.length) {
        const relatedRequests = await this.requests
          .find(
            this.buildTenantCriteria({
              sessionId,
              rid: { $in: requestRids },
            }),
          )
          .lean()
          .exec();
        const actionIds = Array.from(
          new Set(
            relatedRequests
              .map((req) => req?.actionId)
              .filter((id): id is string => Boolean(id)),
          ),
        );
        if (actionIds.length) {
          const changeDocs = await this.changes
            .find(
              this.buildTenantCriteria({
                sessionId,
                actionId: { $in: actionIds },
              }),
            )
            .sort({ t: 1 })
            .limit(limit)
            .lean()
            .exec();
          forwardSeed.changes = changeDocs.map((doc) =>
            this.sanitize(hydrateChangeDoc(doc)),
          );
        }
      }
    } else if (plan.target === 'changes') {
      const branchPlan = this.pickPlanMongo(plan, 'changes');
      const filter = this.buildChangeFilter(plan);
      const query = this.buildTenantCriteria(
        { sessionId },
        branchPlan?.filter,
        filter,
      );
      const changeDocs = await this.changes
        .find(query)
        .sort(branchPlan?.sort ?? { t: 1 })
        .limit(branchPlan?.limit ?? limit)
        .lean()
        .exec();
      collections.changes = changeDocs.map((doc) =>
        this.sanitize(hydrateChangeDoc(doc)),
      );
    }

    const forwardSuggestions = this.buildForwardSuggestions(
      plan.target,
      forwardSeed,
    );
    return {
      plan,
      collections,
      forwardSuggestions,
    };
  }

  private composeChatExecutionContext(
    sessionDoc: Session,
    execution: ChatPlanExecution,
  ): string {
    const sessionSummary = {
      sessionId: sessionDoc._id,
      appId: sessionDoc.appId,
      userId: sessionDoc.userId,
      userEmail: sessionDoc.userEmail,
      startedAt: sessionDoc.startedAt,
      finishedAt: sessionDoc.finishedAt,
    };
    const payload = {
      target: execution.plan.target,
      plan: execution.plan,
      session: sessionSummary,
      data: execution.collections,
      forwardSuggestions: execution.forwardSuggestions,
    };
    return [
      `--- Query context (${execution.plan.target}) ---`,
      '```json',
      JSON.stringify(payload, this.promptReplacer, 2),
      '```',
      '--- End context ---',
    ].join('\n');
  }

  private buildActionFilter(plan: ChatQueryPlan): Record<string, any> {
    const filter: Record<string, any> = {};
    if (plan.action?.actionId) {
      filter.actionId = plan.action.actionId;
    }
    if (plan.action?.label) {
      filter.label = new RegExp(
        `^${this.escapeRegex(plan.action.label)}$`,
        'i',
      );
    } else if (plan.action?.labelContains) {
      filter.label = new RegExp(
        this.escapeRegex(plan.action.labelContains),
        'i',
      );
    }
    if (typeof plan.action?.hasReq === 'boolean') {
      filter.hasReq = plan.action.hasReq;
    }
    if (typeof plan.action?.hasDb === 'boolean') {
      filter.hasDb = plan.action.hasDb;
    }
    if (typeof plan.action?.error === 'boolean') {
      filter.error = plan.action.error;
    }
    return filter;
  }

  private buildRequestFilter(plan: ChatQueryPlan): Record<string, any> {
    const filter: Record<string, any> = {};
    if (plan.request?.rid) {
      filter.rid = plan.request.rid;
    }
    if (typeof plan.request?.status === 'number') {
      filter.status = plan.request.status;
    }
    if (plan.endpoint?.exactUrl) {
      filter.url = plan.endpoint.exactUrl;
    } else if (plan.endpoint?.urlFragment) {
      filter.url = new RegExp(this.escapeRegex(plan.endpoint.urlFragment), 'i');
    }
    if (plan.endpoint?.method) {
      filter.method = new RegExp(
        `^${this.escapeRegex(plan.endpoint.method)}$`,
        'i',
      );
    }
    if (plan.endpoint?.key) {
      filter.key = new RegExp(`^${this.escapeRegex(plan.endpoint.key)}$`, 'i');
    }
    if (plan.entryPoint?.fn) {
      filter['entryPoint.fn'] = new RegExp(
        `^${this.escapeRegex(plan.entryPoint.fn)}$`,
        'i',
      );
    }
    if (plan.entryPoint?.file) {
      filter['entryPoint.file'] = new RegExp(
        this.escapeRegex(plan.entryPoint.file),
        'i',
      );
    }
    if (typeof plan.entryPoint?.line === 'number') {
      filter['entryPoint.line'] = Math.max(0, Math.round(plan.entryPoint.line));
    }
    if (plan.action?.actionId) {
      filter.actionId = plan.action.actionId;
    }
    return filter;
  }

  private buildChangeFilter(plan: ChatQueryPlan): Record<string, any> {
    const filter: Record<string, any> = {};
    if (plan.change?.collection) {
      filter.collection = new RegExp(
        `^${this.escapeRegex(plan.change.collection)}$`,
        'i',
      );
    }
    if (plan.change?.op) {
      filter.op = new RegExp(`^${this.escapeRegex(plan.change.op)}$`, 'i');
    }
    if (plan.action?.actionId) {
      filter.actionId = plan.action.actionId;
    }
    return filter;
  }

  private async fetchTracesForPlan(
    sessionId: string,
    plan: ChatQueryPlan,
    limit: number,
    hintMessages: HintMessageParam[],
    planFilter?: Record<string, any>,
    planSort?: Record<string, 1 | -1>,
  ): Promise<any[]> {
    const fnSet = new Set<string>();
    if (plan.functionName) {
      fnSet.add(plan.functionName);
    }
    if (plan.entryPoint?.fn) {
      fnSet.add(plan.entryPoint.fn);
    }
    const requestRidList: string[] = [];
    if (plan.request?.rid) {
      requestRidList.push(plan.request.rid);
    }
    const traces = await this.fetchTracesForFunctions(
      sessionId,
      Array.from(fnSet),
      requestRidList,
      limit,
      hintMessages,
      planFilter,
      planSort,
    );
    if (traces.length || planFilter || fnSet.size || requestRidList.length) {
      return traces;
    }
    return this.fetchTracesForFunctions(
      sessionId,
      [],
      [],
      limit,
      hintMessages,
    );
  }

  private async fetchTracesForFunctions(
    sessionId: string,
    functionNames: string[],
    requestRids: string[],
    limit: number,
    hintMessages: HintMessageParam[],
    planFilter?: Record<string, any>,
    planSort?: Record<string, 1 | -1>,
  ): Promise<any[]> {
    const fnRegexes = Array.from(
      new Set(
        functionNames
          .map((fn) => fn?.trim())
          .filter(Boolean)
          .map((fn) => new RegExp(`^${this.escapeRegex(fn)}$`, 'i')),
      ),
    );
    const filter: Record<string, any> = {};
    if (fnRegexes.length === 1) {
      filter['codeRefs.fn'] = fnRegexes[0];
    } else if (fnRegexes.length > 1) {
      filter['codeRefs.fn'] = { $in: fnRegexes };
    }
    if (requestRids.length === 1) {
      filter.requestRid = requestRids[0];
    } else if (requestRids.length > 1) {
      filter.requestRid = { $in: requestRids };
    }
    const query = this.buildTenantCriteria(
      { sessionId },
      planFilter,
      filter,
    );
    const docs = await this.traces
      .find(query)
      .sort(planSort ?? { batchIndex: 1 })
      .limit(
        Math.max(limit, fnRegexes.length ? limit * fnRegexes.length : limit),
      )
      .lean()
      .exec();
    if (!docs?.length) {
      return [];
    }
    const trimmed = await this.limitTracePayloads(
      sessionId,
      docs,
      hintMessages,
    );
    return trimmed.map((doc) => this.sanitize(doc));
  }

  private collectTraceChildFunctions(
    traces: any[],
    entryFnSet: Set<string>,
  ): Array<{ fn: string; file?: string; line?: number }> {
    if (!traces?.length) {
      return [];
    }
    const normalizedEntryFns = new Set(
      Array.from(entryFnSet).map((fn) => this.normalizeFunctionName(fn)),
    );
    const suggestions: Array<{ fn: string; file?: string; line?: number }> = [];
    for (const trace of traces) {
      const events: Array<Record<string, any>> = Array.isArray(
        trace?.data?.events,
      )
        ? trace.data.events
        : [];
      for (const event of events) {
        const fn =
          typeof event?.fn === 'string' && event.fn.trim()
            ? event.fn.trim()
            : undefined;
        if (!fn) {
          continue;
        }
        const normalized = this.normalizeFunctionName(fn);
        if (!normalized || normalizedEntryFns.has(normalized)) {
          continue;
        }
        if (
          suggestions.some(
            (item) => this.normalizeFunctionName(item.fn) === normalized,
          )
        ) {
          continue;
        }
        suggestions.push({
          fn,
          file: event?.file,
          line:
            typeof event?.line === 'number' && Number.isFinite(event.line)
              ? Math.round(event.line)
              : undefined,
        });
      }
    }
    return suggestions.slice(0, 5);
  }

  private buildForwardSuggestions(
    target: ChatCollection,
    seed: ChatForwardSeed,
  ): string[] {
    if (target === 'actions') {
      return (seed.requests ?? []).slice(0, 3).map((req) => {
        const method = req.method ?? 'REQUEST';
        const url =
          this.toShortText(req.url ?? req.key ?? req.rid, 80) ??
          'unknown endpoint';
        return `${method} ${url}`.trim();
      });
    }
    if (target === 'requests') {
      return (seed.childFunctions ?? []).slice(0, 3).map((fn) => {
        const location = fn.file
          ? `${fn.file}${fn.line ? `:${fn.line}` : ''}`
          : 'location unavailable';
        return `Inspect ${fn.fn} (${location})`;
      });
    }
    if (target === 'traces') {
      return (seed.changes ?? []).slice(0, 3).map((change) => {
        const op = change.op ?? 'operation';
        const collection = change.collection ?? 'collection';
        return `${op} on ${collection}`;
      });
    }
    return [];
  }

  private async fetchSessionCounts(
    sessionId: string,
  ): Promise<Record<string, number>> {
    const [actions, requests, traces, dbChanges, emails] = await Promise.all([
      this.actions.countDocuments(this.tenantFilter({ sessionId })),
      this.requests.countDocuments(this.tenantFilter({ sessionId })),
      this.traces.countDocuments(this.tenantFilter({ sessionId })),
      this.changes.countDocuments(this.tenantFilter({ sessionId })),
      this.emails.countDocuments(this.tenantFilter({ sessionId })),
    ]);
    return { actions, requests, traces, dbChanges, emails };
  }

  private extractFunctionCandidates(text: string): string[] {
    if (!text) {
      return [];
    }
    const candidates = new Set<string>();
    const callRegex = /([A-Za-z0-9_$]+\.[A-Za-z0-9_$]+|[A-Za-z0-9_$]+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(text))) {
      const fn = match[1]?.trim();
      if (fn) {
        candidates.add(fn);
      }
    }
    const camelRegex = /\b([a-z]+[A-Z][A-Za-z0-9_$]+)\b/g;
    while ((match = camelRegex.exec(text))) {
      if (match[1]) {
        candidates.add(match[1]);
      }
    }
    return Array.from(candidates).slice(0, 3);
  }

  private tryParseJson<T = any>(payload: string): T | undefined {
    if (!payload) {
      return undefined;
    }
    let text = payload.trim();
    if (text.startsWith('```')) {
      text = text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return undefined;
    }
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
    const requestPayloadLookup = this.buildRequestPayloadLookup(
      payload.timeline.requests,
    );
    this.attachRequestContextToTraceCodeRefs(
      payload.timeline.traces,
      requestPayloadLookup,
    );
    const traceIndex = this.indexTraceCodeRefs(
      payload.timeline.traces,
      requestPayloadLookup,
    );
    const datasetCodeRefs = this.collectDatasetCodeRefs(
      payload.timeline.requests,
      payload.timeline.traces,
    );
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
      codeRefs: datasetCodeRefs,
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
    const requestsByAction = this.groupRequestIndexByAction(requestIndex);

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

    const pushStructuredChunk = (chunk?: StructuredChunk) => {
      if (!chunk) {
        return;
      }
      const body = {
        chunkId: chunk.id,
        type: chunk.type,
        ...chunk.body,
      };
      const metadataExtras: Record<string, any> = {};
      const codeRefsArray = Array.isArray((body as any)?.codeRefs)
        ? ((body as any).codeRefs as Array<Record<string, any>>)
        : undefined;
      if (codeRefsArray?.length) {
        const fnWordSet = new Set<string>();
        codeRefsArray.forEach((ref) => {
          const name =
            typeof ref?.functionName === 'string'
              ? ref.functionName
              : typeof ref?.fn === 'string'
                ? ref.fn
                : undefined;
          this.tokenizeFunctionName(name).forEach((word) =>
            fnWordSet.add(word),
          );
        });
        if (fnWordSet.size) {
          metadataExtras.codeRefFnWords = Array.from(fnWordSet).slice(0, 30);
        }
      }
      pushChunk({
        id: chunk.id,
        kind: chunk.kind,
        metadata: {
          ...(chunk.metadata ?? {}),
          ...metadataExtras,
          chunkType: chunk.type,
        },
        text: this.buildStructuredChunkText(body),
      });
    };

    pushStructuredChunk(this.createOverviewChunk(payload.session));
    pushStructuredChunk(this.createCountsChunk(payload.timeline));

    payload.timeline.actions.forEach((action, index) => {
      pushStructuredChunk(
        this.createActionChunk(action, index, requestsByAction),
      );
    });

    payload.timeline.requests.forEach((request, index) => {
      pushStructuredChunk(
        this.createRequestChunk(request, index, actionIndex, traceIndex),
      );
    });

    payload.timeline.dbChanges.forEach((change, index) => {
      pushStructuredChunk(
        this.createDbChangeChunk(change, index, requestIndex),
      );
    });

    payload.timeline.emails.forEach((email, index) => {
      pushStructuredChunk(this.createEmailChunk(email, index));
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
      const isFocus =
        entry.__focus === true || focusChunkIdSet.has(entry.chunkId ?? '');
      const chunk = this.createTraceSummaryChunk(
        entry,
        idx,
        requestIndex,
        timelineContext,
        isFocus,
      );
      pushStructuredChunk(chunk);
      if (isFocus && chunk) {
        focusChunkIds.add(chunk.id);
        if (chunk.metadata?.functionName) {
          focusFunctions.add(chunk.metadata.functionName);
        }
      }
    });

    if (!combinedEntries.length && payload.timeline.traces.length) {
      payload.timeline.traces
        .slice(0, TRACE_TRACE_SAMPLE_LIMIT)
        .forEach((trace, index) => {
          pushStructuredChunk(
            this.createFallbackTraceChunk(
              trace,
              index,
              requestIndex,
              actionIndex,
            ),
          );
        });
    }

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

  private createOverviewChunk(session: Record<string, any>): StructuredChunk {
    const sessionId = session?.id ?? session?.sessionId ?? 'unknown';
    const startedAt = this.toIsoTimestamp(session?.startedAt);
    const finishedAt = this.toIsoTimestamp(
      session?.finishedAt ?? session?.endedAt,
    );
    const user = session?.userEmail ?? session?.userId ?? 'unknown user';
    return {
      id: 'overview',
      kind: 'overview',
      type: 'SESSION_OVERVIEW',
      metadata: {
        sessionId,
        appId: session?.appId ?? 'unknown',
      },
      body: {
        sessionId,
        appId: session?.appId ?? 'unknown',
        user,
        startedAt,
        finishedAt,
        notes: session?.notes ?? null,
      },
    };
  }

  private createCountsChunk(timeline: {
    actions: any[];
    requests: any[];
    traces: any[];
    dbChanges: any[];
    emails: any[];
  }): StructuredChunk {
    return {
      id: 'counts',
      kind: 'counts',
      type: 'SESSION_COUNTS',
      body: {
        counts: {
          actions: timeline.actions.length,
          requests: timeline.requests.length,
          traces: timeline.traces.length,
          dbChanges: timeline.dbChanges.length,
          emails: timeline.emails.length,
        },
      },
    };
  }

  private groupRequestIndexByAction(
    requestIndex: RequestIndex,
  ): Map<string, RequestIndexEntry[]> {
    const map = new Map<string, RequestIndexEntry[]>();
    Object.values(requestIndex ?? {}).forEach((entry) => {
      if (!entry?.actionId) {
        return;
      }
      const list = map.get(entry.actionId) ?? [];
      list.push(entry);
      map.set(entry.actionId, list);
    });
    return map;
  }

  private createActionChunk(
    action: any,
    index: number,
    requestsByAction: Map<string, RequestIndexEntry[]>,
  ): StructuredChunk | undefined {
    if (!action || typeof action !== 'object') {
      return undefined;
    }
    const actionId = action.actionId ?? action.id ?? `action_${index + 1}`;
    const relatedRequest = actionId
      ? requestsByAction.get(actionId)?.[0]
      : undefined;
    return {
      id: `action:${actionId}`,
      kind: 'action',
      type: 'FRONTEND_ACTION',
      metadata: {
        actionId,
        rid: relatedRequest?.rid,
        requestId: relatedRequest?.rid,
        method: relatedRequest?.method,
        url: relatedRequest?.url,
        endpoint: relatedRequest?.url,
      },
      body: {
        actionId,
        actionName: this.toShortText(
          action.label ?? action.type ?? 'action',
          160,
        ),
        requestId: relatedRequest?.rid ?? null,
        endpoint: relatedRequest?.url ?? null,
        method: relatedRequest?.method ?? null,
        timeline: {
          startedAt: this.toIsoTimestamp(action.tStart ?? action.t),
          endedAt: this.toIsoTimestamp(action.tEnd),
          durationMs: this.computeDurationMs(action.tStart, action.tEnd),
        },
        flags: {
          hasRequest: Boolean(action.hasReq),
          hasDbChange: Boolean(action.hasDb),
          error: Boolean(action.error),
        },
        uiContext: action?.ui ?? null,
      },
    };
  }

  private createRequestChunk(
    request: any,
    index: number,
    actionIndex: ActionIndex,
    traceIndex: TraceRefIndex,
  ): StructuredChunk | undefined {
    if (!request || typeof request !== 'object') {
      return undefined;
    }
    const rid = request.rid ?? request.requestRid ?? `req_${index + 1}`;
    const method = (request.method ?? 'GET').toUpperCase();
    const url = this.describeUrl(request.url);
    const actionId = request.actionId ?? request.aid ?? null;
    const actionRef = this.lookupAction(actionIndex, actionId ?? undefined);
    const requestCodeRefs = this.extractStoredCodeRefs(request?.codeRefs);
    const traceRefs = traceIndex[rid ?? '']?.codeRefs ?? [];
    const combinedRefs = this.mergeCodeRefs(requestCodeRefs, traceRefs);
    const detailedRefs = this.buildCodeRefContextEntries(combinedRefs);
    return {
      id: `request:${rid}`,
      kind: 'request',
      type: 'REQUEST',
      metadata: {
        rid,
        requestId: rid,
        actionId,
        method,
        url,
        endpoint: url,
        files: combinedRefs.map((ref) => ref.file),
      },
      body: {
        requestId: rid,
        method,
        endpoint: url,
        status:
          typeof request.status === 'number'
            ? request.status
            : request.error
              ? request.error
              : null,
        durationMs: this.resolveRequestDuration(request),
        timestamp: this.toIsoTimestamp(request.t),
        actionId,
        actionLabel: actionRef?.label ?? null,
        params: request.params ?? null,
        query: request.query ?? null,
        body: request.body ?? null,
        response: request.respBody ?? null,
        headers: request.headers ?? null,
        codeRefs: detailedRefs,
      },
    };
  }

  private resolveRequestDuration(request: any): number | null {
    if (typeof request?.durMs === 'number' && Number.isFinite(request.durMs)) {
      return Math.round(request.durMs);
    }
    if (
      typeof request?.duration === 'number' &&
      Number.isFinite(request.duration)
    ) {
      return Math.round(request.duration);
    }
    return null;
  }

  private computeDurationMs(start?: number, end?: number): number | null {
    if (
      typeof start === 'number' &&
      Number.isFinite(start) &&
      typeof end === 'number' &&
      Number.isFinite(end)
    ) {
      return Math.max(0, Math.round(end - start));
    }
    return null;
  }

  private toIsoTimestamp(value: any): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      try {
        return new Date(value).toISOString();
      } catch {
        return null;
      }
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string' && value.length) {
      return value;
    }
    return null;
  }

  private createDbChangeChunk(
    change: any,
    index: number,
    requestIndex: RequestIndex,
  ): StructuredChunk | undefined {
    if (!change || typeof change !== 'object') {
      return undefined;
    }
    const changeId = change.id ?? `db_${index + 1}`;
    const rid = change.requestRid ?? change.rid ?? null;
    const requestRef = rid ? requestIndex[rid] : undefined;
    const collection = change.collection ?? change.table ?? 'unknown';
    const op = (change.op ?? change.operation ?? 'operation').toUpperCase();
    return {
      id: `db:${changeId}`,
      kind: 'dbChange',
      type: 'DB_CHANGE',
      metadata: {
        changeId,
        actionId: change.actionId ?? null,
        rid,
        requestId: rid,
        endpoint: requestRef?.url,
        method: requestRef?.method,
        collection,
      },
      body: {
        changeId,
        requestId: rid ?? null,
        actionId: change.actionId ?? null,
        endpoint: requestRef?.url ?? null,
        table: collection,
        operation: op,
        timestamp: this.toIsoTimestamp(change.t),
        durationMs:
          typeof change.durMs === 'number' && Number.isFinite(change.durMs)
            ? Math.round(change.durMs)
            : null,
        before: change.before ?? null,
        after: change.after ?? null,
        query: change.query ?? null,
        resultMeta: change.resultMeta ?? null,
        error: change.error ?? null,
      },
    };
  }

  private createEmailChunk(
    email: any,
    index: number,
  ): StructuredChunk | undefined {
    if (!email || typeof email !== 'object') {
      return undefined;
    }
    const emailId = email.id ?? `email_${index + 1}`;
    return {
      id: `email:${emailId}`,
      kind: 'email',
      type: 'EMAIL',
      metadata: {
        actionId: email.actionId ?? null,
        rid: email.requestRid ?? email.rid ?? null,
        subject: this.toShortText(email.subject ?? '(no subject)', 160),
      },
      body: {
        emailId,
        subject: email.subject ?? '(no subject)',
        to: email.to ?? null,
        cc: email.cc ?? null,
        bcc: email.bcc ?? null,
        timestamp: this.toIsoTimestamp(email.t),
        statusCode: email.statusCode ?? null,
        durationMs:
          typeof email.durMs === 'number' && Number.isFinite(email.durMs)
            ? Math.round(email.durMs)
            : null,
        textPreview: email.text ?? null,
      },
    };
  }

  private createTraceSummaryChunk(
    entry: TraceSummaryEntry,
    index: number,
    requestIndex: RequestIndex,
    timeline: TimelineContext,
    isFocus: boolean,
  ): StructuredChunk | undefined {
    if (!entry) {
      return undefined;
    }
    const rid = entry.requestRid ?? undefined;
    const requestRef = rid ? requestIndex[rid] : undefined;
    const chunkId =
      entry.chunkId ??
      `trace-summary:${entry.groupId}:${entry.segmentIndex ?? index}`;
    const functionName =
      entry.functionName ?? entry.nodeDetail?.functionName ?? undefined;
    const filename = entry.filePath ?? entry.nodeDetail?.filePath ?? undefined;
    const lineNumber = this.deriveLineNumberFromEntry(entry);
    const args = this.resolveTraceArgs(entry, requestRef);
    const dbChanges = this.findRelatedDbChanges(entry, timeline.dbChanges).map(
      (change) => ({
        changeId: change.id ?? null,
        table: change.collection ?? change.table ?? null,
        operation: change.op ?? change.operation ?? null,
        summary: change.summary ?? null,
      }),
    );
    const emails = this.findRelatedEmails(entry, timeline.emails).map(
      (email) => ({
        subject: this.toShortText(email.subject ?? '(no subject)', 160),
        to: email.to ?? null,
        statusCode: email.statusCode ?? null,
      }),
    );
    return {
      id: chunkId,
      kind: 'trace',
      type: 'TRACE_CALL',
      metadata: {
        rid,
        requestId: rid,
        actionId: entry.actionId ?? undefined,
        traceId: entry.groupId,
        files: this.collectFilesForTraceEntry(entry),
        functionName,
        endpoint: requestRef?.url,
        method: requestRef?.method,
        depth: entry.depth ?? entry.nodeDetail?.depth ?? null,
        focus: isFocus || undefined,
      },
      body: {
        chunkId,
        traceId: entry.groupId,
        requestId: rid ?? null,
        endpoint: requestRef ? `${requestRef.method} ${requestRef.url}` : null,
        actionId: entry.actionId ?? null,
        functionName: functionName ?? null,
        filename: filename ?? null,
        lineStart: lineNumber ?? null,
        lineEnd: lineNumber ?? null,
        depth: entry.depth ?? entry.nodeDetail?.depth ?? null,
        args: args ?? null,
        result: this.parseJsonPreview(entry.nodeDetail?.resultPreview),
        summary: entry.summary ?? null,
        eventRange: {
          start: entry.eventStart,
          end: entry.eventEnd,
          count: entry.eventCount,
        },
        callStack: this.buildTraceCallStack(entry.lineageTrail),
        childrenCalls: this.buildTraceChildCalls(entry.childSummaries),
        previewEvents: this.buildTracePreviewEvents(entry.previewEvents),
        durationMs: entry.nodeDetail?.durationMs ?? null,
        dbChanges,
        emails,
      },
    };
  }

  private resolveTraceArgs(
    entry: TraceSummaryEntry,
    requestRef?: RequestIndexEntry,
  ): any {
    const traceArgs = this.parseJsonPreview(entry.nodeDetail?.argsPreview);
    if (traceArgs !== undefined) {
      return traceArgs;
    }
    const fallback =
      requestRef?.bodyPreview ??
      requestRef?.paramsPreview ??
      requestRef?.queryPreview ??
      requestRef?.headersPreview;
    return this.parseJsonPreview(fallback);
  }

  private parseJsonPreview(value?: string | null): any {
    if (value == null) {
      return undefined;
    }
    if (typeof value === 'object') {
      return value;
    }
    if (typeof value !== 'string' || !value.trim().length) {
      return undefined;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private buildTraceCallStack(
    lineage?: TraceSummaryEntry['lineageTrail'],
  ): Array<Record<string, any>> | null {
    if (!lineage?.length) {
      return null;
    }
    return lineage.slice(0, 8).map((trail) => ({
      chunkId: trail.chunkId ?? null,
      relation: trail.relation,
      functionName: trail.functionName ?? null,
      filename: trail.filePath ?? null,
      lineNumber: trail.lineNumber ?? null,
      depth: trail.depth ?? null,
    }));
  }

  private buildTraceChildCalls(
    children?: TraceSummaryEntry['childSummaries'],
  ): Array<Record<string, any>> | null {
    if (!children?.length) {
      return null;
    }
    return children.slice(0, 3).map((child) => ({
      chunkId: child.chunkId ?? null,
      functionName: child.functionName ?? null,
      filename: child.filePath ?? null,
      lineNumber: child.lineNumber ?? null,
      depth: child.depth ?? null,
    }));
  }

  private buildTracePreviewEvents(
    events?: TraceSummaryEntry['previewEvents'],
  ): Array<Record<string, any>> | null {
    if (!events?.length) {
      return null;
    }
    return events.slice(0, 8).map((event) => ({
      fn: event?.fn ?? null,
      file: event?.file ?? null,
      line: event?.line ?? null,
      type: event?.type ?? null,
    }));
  }

  private deriveLineNumberFromEntry(
    entry: TraceSummaryEntry,
  ): number | undefined {
    if (
      typeof entry.lineNumber === 'number' &&
      Number.isFinite(entry.lineNumber)
    ) {
      return Math.floor(entry.lineNumber);
    }
    if (
      typeof entry.nodeDetail?.lineNumber === 'number' &&
      Number.isFinite(entry.nodeDetail.lineNumber)
    ) {
      return Math.floor(entry.nodeDetail.lineNumber);
    }
    const previewLine = entry.previewEvents?.find(
      (evt) => typeof evt?.line === 'number' && Number.isFinite(evt.line),
    )?.line;
    return typeof previewLine === 'number'
      ? Math.floor(previewLine)
      : undefined;
  }

  private createFallbackTraceChunk(
    trace: any,
    index: number,
    requestIndex: RequestIndex,
    actionIndex: ActionIndex,
  ): StructuredChunk | undefined {
    if (!trace || typeof trace !== 'object') {
      return undefined;
    }
    const rid = trace.requestRid ?? trace.rid ?? `trace_${index + 1}`;
    const requestRef = this.lookupRequest(requestIndex, rid);
    const actionId = trace.actionId ?? trace.aid ?? null;
    const actionRef = this.lookupAction(actionIndex, actionId ?? undefined);
    const events = this.normalizeTraceEvents(trace.data).slice(0, 12);
    const codeRefs = this.buildCodeRefContextEntries(
      this.extractStoredCodeRefs(trace?.codeRefs),
    );
    return {
      id: `traceFallback:${rid}:${index}`,
      kind: 'trace',
      type: 'TRACE_CALL',
      metadata: {
        rid,
        requestId: rid,
        actionId,
        files: this.collectTraceFilesFromTraceDoc(trace),
      },
      body: {
        requestId: rid,
        endpoint: requestRef ? `${requestRef.method} ${requestRef.url}` : null,
        actionId,
        actionLabel: actionRef?.label ?? null,
        functionName: events[0]?.fn ?? null,
        filename: events[0]?.file ?? null,
        lineStart: events[0]?.line ?? null,
        lineEnd: events[events.length - 1]?.line ?? null,
        previewEvents: events.map((evt) => ({
          fn: evt?.fn ?? null,
          file: evt?.file ?? null,
          line: evt?.line ?? null,
          type: evt?.type ?? null,
        })),
        codeRefs,
        note: 'Trace data included directly because no precomputed function segment was available.',
      },
    };
  }

  private buildStructuredChunkText(payload: Record<string, any>): string {
    const normalized = this.normalizeChunkValue(payload, 0);
    return JSON.stringify(normalized, null, 2);
  }

  private normalizeChunkValue(value: any, depth = 0): any {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      const limit =
        depth === 0 ? CHUNK_STRING_ROOT_LIMIT : CHUNK_STRING_NESTED_LIMIT;
      if (trimmed.length <= limit) {
        return trimmed;
      }
      return `${trimmed.slice(0, limit)}... (truncated)`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
      return value.toString('base64');
    }
    if (Array.isArray(value)) {
      const limit =
        depth === 0 ? CHUNK_ARRAY_ROOT_LIMIT : CHUNK_ARRAY_NESTED_LIMIT;
      const normalized = value
        .slice(0, limit)
        .map((item) => this.normalizeChunkValue(item, depth + 1))
        .filter((item) => item !== undefined);
      if (value.length > limit) {
        normalized.push('...(truncated list)');
      }
      return normalized;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined);
      const limit =
        depth === 0 ? CHUNK_OBJECT_ROOT_LIMIT : CHUNK_OBJECT_NESTED_LIMIT;
      const result: Record<string, any> = {};
      entries.slice(0, limit).forEach(([key, val]) => {
        const normalized = this.normalizeChunkValue(val, depth + 1);
        if (normalized !== undefined) {
          result[key] = normalized;
        }
      });
      if (entries.length > limit) {
        result.__truncated = true;
      }
      return result;
    }
    return String(value);
  }

  private cosineSimilarity(a?: number[], b?: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const va = a[i];
      const vb = b[i];
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    if (!normA || !normB) {
      return 0;
    }
    return dot / Math.sqrt(normA * normB);
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

  private buildCodeRefContextEntries(
    refs: CodeRef[],
  ): Array<Record<string, any>> {
    if (!refs?.length) {
      return [];
    }
    return refs.slice(0, CODE_REF_CONTEXT_LIMIT).map((ref) => ({
      file: ref.file,
      line: ref.line ?? null,
      functionName: ref.fn ?? null,
      argsPreview: ref.argsPreview ?? null,
      resultPreview: ref.resultPreview ?? null,
      durationMs: ref.durationMs ?? null,
      metadata: ref.metadata ?? null,
    }));
  }

  private indexTraceCodeRefs(
    traces: any[],
    requestLookup: Record<string, RequestPayloadContext> = {},
  ): TraceRefIndex {
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
      const context = requestLookup[rid];
      const enrichedRefs = context
        ? refs.map((ref) => this.enrichCodeRefWithRequestContext(ref, context))
        : refs;
      map[rid] = {
        rid,
        codeRefs: enrichedRefs,
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
      return path.startsWith('/')
        ? path.toLowerCase()
        : `/${path.toLowerCase()}`;
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

  private buildRequestPayloadLookup(
    requests: any[],
  ): Record<string, RequestPayloadContext> {
    const lookup: Record<string, RequestPayloadContext> = {};
    for (const request of requests ?? []) {
      if (!request || typeof request !== 'object') {
        continue;
      }
      const rid = request.rid ?? request.requestRid;
      if (!rid) {
        continue;
      }
      lookup[rid] = {
        bodyPreview: this.previewJson(request.body, 1200),
        responsePreview: this.previewJson(request.respBody, 1200),
      };
    }
    return lookup;
  }

  private attachRequestContextToTraceCodeRefs(
    traces: any[],
    lookup: Record<string, RequestPayloadContext>,
  ): void {
    if (!traces?.length) {
      return;
    }
    traces.forEach((trace) => {
      if (!trace || typeof trace !== 'object') {
        return;
      }
      if (!Array.isArray(trace.codeRefs) || !trace.codeRefs.length) {
        return;
      }
      const rid = trace.requestRid ?? trace.rid;
      if (!rid) {
        return;
      }
      const context = lookup[rid];
      if (!context || (!context.bodyPreview && !context.responsePreview)) {
        return;
      }
      trace.codeRefs = trace.codeRefs.map((ref: any) => ({
        ...(ref ?? {}),
        metadata: {
          ...(ref?.metadata && typeof ref.metadata === 'object'
            ? ref.metadata
            : {}),
          requestBody: context.bodyPreview ?? undefined,
          responseBody: context.responsePreview ?? undefined,
        },
      }));
    });
  }

  private enrichCodeRefWithRequestContext(
    ref: CodeRef,
    context?: RequestPayloadContext,
  ): CodeRef {
    if (!context || (!context.bodyPreview && !context.responsePreview)) {
      return ref;
    }
    return {
      ...ref,
      metadata: {
        ...(ref.metadata ?? {}),
        requestBody: context.bodyPreview ?? undefined,
        responseBody: context.responsePreview ?? undefined,
      },
    };
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
    const argsPreview =
      typeof entry.argsPreview === 'string'
        ? entry.argsPreview
        : this.previewJson(entry.argsPreview, 400);
    const resultPreview =
      typeof entry.resultPreview === 'string'
        ? entry.resultPreview
        : this.previewJson(entry.resultPreview, 400);
    const durationMs =
      typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
        ? Math.max(0, Math.round(entry.durationMs))
        : undefined;
    const metadata =
      entry.metadata && typeof entry.metadata === 'object'
        ? entry.metadata
        : undefined;
    return {
      file: this.normalizeFileHint(file) || file,
      line,
      fn,
      argsPreview: argsPreview ?? undefined,
      resultPreview: resultPreview ?? undefined,
      durationMs,
      metadata,
    };
  }

  private extractStoredCodeRefs(entries: any): CodeRef[] {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map((entry) => this.normalizeStoredCodeRef(entry))
      .filter((entry): entry is CodeRef => Boolean(entry));
  }

  private collectDatasetCodeRefs(
    requests: any[],
    traces: any[],
  ): DatasetCodeRef[] {
    const refs: DatasetCodeRef[] = [];
    requests?.forEach((request) => {
      if (!request) return;
      const rid = request.rid ?? request.requestRid;
      const actionId = request.actionId ?? request.aid ?? null;
      this.extractStoredCodeRefs(request.codeRefs).forEach((ref) => {
        refs.push({
          ...ref,
          rid,
          actionId,
          source: 'request',
        });
      });
    });
    traces?.forEach((trace) => {
      if (!trace) return;
      const rid = trace.requestRid ?? trace.rid;
      const actionId = trace.actionId ?? trace.aid ?? null;
      this.extractStoredCodeRefs(trace.codeRefs).forEach((ref) => {
        refs.push({
          ...ref,
          rid,
          actionId,
          source: 'trace',
        });
      });
    });
    return refs;
  }

  private mergeCodeRefs(primary: CodeRef[], secondary: CodeRef[]): CodeRef[] {
    if (!secondary?.length) {
      return primary.slice();
    }
    const merged: CodeRef[] = [];
    const map = new Map<string, CodeRef>();
    const upsert = (ref: CodeRef) => {
      const key = `${ref.file}|${ref.line ?? 'na'}|${ref.fn ?? ''}`;
      const existing = map.get(key);
      if (!existing) {
        const clone: CodeRef = { ...ref };
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
    primary.forEach((ref) => upsert(ref));
    secondary.forEach((ref) => upsert(ref));
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
    const limitedChildren = (entry.childSummaries ?? []).slice(0, 3);
    const children = limitedChildren
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
        (email, idx) => `  - [${idx + 1}] ${this.describeEmailSummary(email)}`,
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
      entry.functionName ?? node?.functionName ?? 'function name unavailable';
    const effectiveFile =
      entry.filePath ?? node?.filePath ?? 'location unavailable';
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
      actionRef?.startedAt
        ? `actionWindow: ${actionRef.startedAt} → ${actionRef.endedAt ?? 'open'}`
        : undefined,
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
        ? [
            'request headers:',
            '```json',
            requestRef.headersPreview,
            '```',
          ].join('\n')
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
    return [subject, recipients, status, dur].filter(Boolean).join(' | ');
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
    const combine = (entry: TraceSummaryEntry, isFocus: boolean): void => {
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
    const requestId = chunk.metadata?.requestId ?? chunk.metadata?.rid;
    if (chunk.metadata?.url || chunk.metadata?.endpoint) {
      const urlValue = String(chunk.metadata.url ?? chunk.metadata.endpoint);
      score += this.scoreTextAgainstKeywords(urlValue, keywordList);
      const path = this.normalizeEndpointPath(urlValue);
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
    if (requestId) {
      score += this.scoreTextAgainstKeywords(String(requestId), keywordList);
      if (tokens.requestIds.has(String(requestId).toLowerCase())) {
        score += 4;
      }
    }
    if (chunk.metadata?.actionId) {
      score += this.scoreTextAgainstKeywords(
        String(chunk.metadata.actionId),
        keywordList,
      );
      if (tokens.actionIds.has(String(chunk.metadata.actionId).toLowerCase())) {
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
    const codeRefFnWords: string[] = Array.isArray(
      chunk.metadata?.codeRefFnWords,
    )
      ? (chunk.metadata?.codeRefFnWords as string[])
      : [];
    if (codeRefFnWords.length && tokens.functionWords.size) {
      codeRefFnWords.forEach((word) => {
        if (tokens.functionWords.has(word)) {
          score += 1.5;
        }
      });
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
      if (meta.requestId) relatedKeys.add(`rid:${meta.requestId}`);
      if (meta.actionId) relatedKeys.add(`action:${meta.actionId}`);
      if (meta.traceId) relatedKeys.add(`trace:${meta.traceId}`);
    });

    for (const chunk of allChunks) {
      if (out.length >= limit) break;
      if (seen.has(chunk.id)) continue;
      const meta = chunk.metadata ?? {};
      if (
        (meta.rid && relatedKeys.has(`rid:${meta.rid}`)) ||
        (meta.requestId && relatedKeys.has(`rid:${meta.requestId}`)) ||
        (meta.actionId && relatedKeys.has(`action:${meta.actionId}`)) ||
        (meta.traceId && relatedKeys.has(`trace:${meta.traceId}`))
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
      if (meta.requestId) relatedKeys.add(`rid:${meta.requestId}`);
      if (meta.actionId) relatedKeys.add(`action:${meta.actionId}`);
      if (meta.traceId) relatedKeys.add(`trace:${meta.traceId}`);
    };

    focusIds.forEach((id) => addChunk(chunkById.get(id)));

    if (selected.length < limit) {
      for (const chunk of allChunks) {
        if (selected.length >= limit) break;
        if (seen.has(chunk.id)) continue;
        const meta = chunk.metadata ?? {};
        if (
          (meta.rid && relatedKeys.has(`rid:${meta.rid}`)) ||
          (meta.requestId && relatedKeys.has(`rid:${meta.requestId}`)) ||
          (meta.actionId && relatedKeys.has(`action:${meta.actionId}`)) ||
          (meta.traceId && relatedKeys.has(`trace:${meta.traceId}`))
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
      const ridCandidate =
        typeof meta.requestId === 'string'
          ? meta.requestId
          : typeof meta.rid === 'string'
            ? meta.rid
            : undefined;
      const rid = ridCandidate ? ridCandidate.toLowerCase() : undefined;
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
      const urlHint = meta.url ?? meta.endpoint;
      const urlPath =
        typeof urlHint === 'string'
          ? this.normalizeEndpointPath(urlHint)
          : undefined;
      const method =
        typeof meta.method === 'string' ? meta.method.toUpperCase() : undefined;
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
      const metadataName =
        typeof chunk.metadata?.functionName === 'string'
          ? chunk.metadata.functionName
          : undefined;
      if (metadataName) {
        names.add(metadataName);
        continue;
      }
      try {
        const parsed = JSON.parse(chunk.text ?? '{}');
        const fn =
          typeof parsed?.functionName === 'string'
            ? parsed.functionName
            : typeof parsed?.body?.functionName === 'string'
              ? parsed.body.functionName
              : undefined;
        if (fn) {
          names.add(fn);
        }
      } catch {
        continue;
      }
    }
    return Array.from(names);
  }

  private filterPromptableChunks(chunks: DatasetChunk[]): DatasetChunk[] {
    if (!chunks?.length) {
      return [];
    }
    return chunks.filter((chunk) => chunk.kind !== 'raw');
  }

  private buildEmbeddingText(chunk: DatasetChunk): string {
    const header = [
      `chunkId=${chunk.id}`,
      `kind=${chunk.kind}`,
      this.describeChunkMetadata(chunk),
    ]
      .filter(Boolean)
      .join(' | ');
    const body = chunk.text ?? '';
    const combined = `${header}\n${body}`;
    if (combined.length <= EMBEDDING_CHUNK_CHAR_LIMIT) {
      return combined;
    }
    return combined.slice(0, EMBEDDING_CHUNK_CHAR_LIMIT);
  }

  private async selectChunksForQuestion(params: {
    dataset: SessionDataset;
    question: string;
    hintTokens: HintTokens;
    focusIds: Set<string>;
    client: OpenAI;
  }): Promise<DatasetChunk[]> {
    const promptable = this.filterPromptableChunks(params.dataset.chunks);
    if (!promptable.length) {
      return [];
    }
    const normalizedQuestion =
      params.question?.trim().length > 0
        ? params.question.trim()
        : 'Summarize the most relevant session artifacts.';
    const rankedByHints = promptable
      .map((chunk) => ({
        chunk,
        hintScore: this.scoreDatasetChunk(chunk, params.hintTokens),
      }))
      .sort((a, b) => b.hintScore - a.hintScore);
    const candidateLimit = Math.max(
      EMBEDDING_CANDIDATE_LIMIT,
      CHAT_MAX_DATASET_CHUNKS * 4,
      params.focusIds.size,
    );
    const candidates = rankedByHints
      .slice(0, Math.min(candidateLimit, rankedByHints.length))
      .map((entry) => entry.chunk);
    const candidateSet = new Set(candidates.map((chunk) => chunk.id));
    params.focusIds.forEach((id) => {
      if (candidateSet.has(id)) {
        return;
      }
      const chunk = params.dataset.chunks.find((item) => item.id === id);
      if (chunk && chunk.kind !== 'raw') {
        candidates.push(chunk);
        candidateSet.add(chunk.id);
      }
    });
    if (!candidates.length) {
      return [];
    }

    const embeddingModel =
      this.config.get<string>('OPENAI_EMBEDDING_MODEL')?.trim() ||
      'text-embedding-3-small';

    const inputs = [
      normalizedQuestion,
      ...candidates.map((chunk) => this.buildEmbeddingText(chunk)),
    ];
    const response = await params.client.embeddings.create({
      model: embeddingModel,
      input: inputs,
    });
    if (response.data.length !== inputs.length) {
      throw new Error('Embedding response size mismatch.');
    }
    const questionVector = response.data[0]?.embedding;
    const scored = candidates
      .map((chunk, index) => {
        const embedding = response.data[index + 1]?.embedding;
        const similarity = this.cosineSimilarity(questionVector, embedding);
        const hintBoost =
          this.scoreDatasetChunk(chunk, params.hintTokens) *
          EMBEDDING_HINT_BOOST;
        const focusBoost = params.focusIds.has(chunk.id) ? 0.2 : 0;
        return {
          chunk,
          score: similarity + hintBoost + focusBoost,
        };
      })
      .filter((entry) => Number.isFinite(entry.score));
    if (!scored.length) {
      return [];
    }
    scored.sort((a, b) => b.score - a.score);
    let selected = scored
      .slice(0, CHAT_MAX_DATASET_CHUNKS)
      .map((entry) => entry.chunk);
    selected = this.appendFocusChunks(
      selected,
      params.dataset.chunks,
      params.focusIds,
      CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT,
    );
    selected = this.expandChunksWithRelated(
      selected,
      params.dataset.chunks,
      Math.min(
        params.dataset.chunks.length,
        CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT + 4,
      ),
    );
    return selected;
  }

  private selectChunksWithHeuristics(
    dataset: SessionDataset,
    hintTokens: HintTokens,
    focusIds: Set<string>,
  ): DatasetChunk[] {
    if (focusIds.size) {
      return this.ensureFocusChunkContext(
        dataset.chunks,
        focusIds,
        Math.min(
          dataset.chunks.length,
          CHAT_MAX_DATASET_CHUNKS + FOCUS_CHUNK_EXTRA_LIMIT,
        ),
      );
    }
    const derivedFocus = this.determineFocusChunkIds(
      dataset.chunks,
      hintTokens,
      focusIds,
    );
    let selected = this.selectDatasetChunks(
      dataset.chunks,
      hintTokens,
      CHAT_MAX_DATASET_CHUNKS,
      derivedFocus,
    );
    selected = this.expandChunksWithRelated(
      this.appendFocusChunks(
        selected,
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
    return selected;
  }

  private splitConversationForPrompt(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): {
    history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    latestUser?: OpenAI.Chat.Completions.ChatCompletionMessageParam;
  } {
    if (!messages?.length) {
      return { history: [], latestUser: undefined };
    }
    let lastUserIndex = -1;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'user') {
        lastUserIndex = idx;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return { history: messages, latestUser: undefined };
    }
    const history = messages.slice(0, lastUserIndex);
    return { history, latestUser: messages[lastUserIndex] };
  }

  private composeChunkContext(
    chunks: DatasetChunk[],
    totalChunks: number,
  ): string {
    if (!chunks?.length) {
      return 'Session dataset context unavailable: no chunks selected.';
    }
    const lines: string[] = [
      `--- Context (selected ${chunks.length} of ${totalChunks} chunks) ---`,
    ];
    chunks.forEach((chunk, idx) => {
      const label =
        chunk.metadata?.chunkType ??
        chunk.kind.toUpperCase().replace(/[^A-Z_]/g, '');
      lines.push(
        [
          `Chunk #${idx + 1} [${label}] ${this.describeChunkMetadata(chunk)}`,
          '```json',
          chunk.text,
          '```',
        ].join('\n'),
      );
    });
    lines.push('--- End context ---');
    return lines.join('\n');
  }

  private findMatchingCodeRefs(
    question: string,
    tokens: HintTokens,
    refs: DatasetCodeRef[] = [],
    limit = 8,
  ): DatasetCodeRef[] {
    if (!refs.length || !question?.trim()) {
      return [];
    }
    const normalizedQuestion = question.toLowerCase();
    const questionWordSet = new Set<string>();
    this.tokenizeFunctionName(question).forEach((word) =>
      questionWordSet.add(word),
    );
    tokens.functionWords.forEach((word) => questionWordSet.add(word));
    const matches = refs
      .map((ref, index) => {
        let score = 0;
        const fnNorm = this.normalizeFunctionName(ref.fn);
        if (fnNorm && normalizedQuestion.includes(fnNorm)) {
          score += 8;
        }
        const fnWords = this.tokenizeFunctionName(ref.fn);
        let shared = 0;
        fnWords.forEach((word) => {
          if (questionWordSet.has(word)) {
            shared += 1;
          }
        });
        score += shared * 2;
        if (
          fnNorm.includes('findone') &&
          (normalizedQuestion.includes('findone') ||
            questionWordSet.has('find'))
        ) {
          score += 2;
        }
        const filePath = ref.file ?? '';
        const fileBase = this.getBasename(filePath);
        if (fileBase && normalizedQuestion.includes(fileBase)) {
          score += 2;
        }
        if (tokens.fileBases.has(fileBase)) {
          score += 3;
        }
        if (tokens.files.has(filePath)) {
          score += 3;
        }
        return { ref, score, index };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) =>
        b.score === a.score ? a.index - b.index : b.score - a.score,
      )
      .slice(0, limit)
      .map((entry) => entry.ref);
    return matches;
  }

  private composeCodeRefContext(refs: DatasetCodeRef[]): string {
    if (!refs?.length) {
      return '';
    }
    const lines = [
      `--- Direct code references (${refs.length}) ---`,
      ...refs.map((ref, idx) => {
        const location = ref.file
          ? `${ref.file}${ref.line ? `:${ref.line}` : ''}`
          : 'location unavailable';
        const parts = [
          `[#${idx + 1}] ${ref.fn ?? 'function unknown'} (${ref.source}) ${location}`,
        ];
        if (ref.argsPreview) {
          parts.push(`args=${ref.argsPreview}`);
        }
        if (ref.resultPreview) {
          parts.push(`result=${ref.resultPreview}`);
        }
        if (ref.durationMs != null) {
          parts.push(`durationMs=${ref.durationMs}`);
        }
        if (ref.metadata?.collection || ref.metadata?.operation) {
          const metaParts: string[] = [];
          if (ref.metadata?.collection) {
            metaParts.push(`collection=${ref.metadata.collection}`);
          }
          if (ref.metadata?.operation) {
            metaParts.push(`operation=${ref.metadata.operation}`);
          }
          if (metaParts.length) {
            parts.push(metaParts.join(' '));
          }
        }
        if (ref.rid) {
          parts.push(`rid=${ref.rid}`);
        }
        return parts.join(' | ');
      }),
      '--- End code references ---',
    ];
    return lines.join('\n');
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
          (fn) => new RegExp(`^${this.escapeRegex(fn)}$`, 'i'),
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
      cache.set(node.chunkId, node);
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
      new Set(chunkIds.filter((id) => id && !cache.has(id))),
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
      const fnRegexes = functionHints.map(
        (fn) => new RegExp(`^${this.escapeRegex(fn)}$`, 'i'),
      );
      orFilters.push({ functionName: { $in: fnRegexes } });
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

  private normalizeFunctionName(value?: string | null): string {
    if (!value) {
      return '';
    }
    return value
      .replace(/^this\./i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  private tokenizeFunctionName(value?: string | null): string[] {
    if (!value) {
      return [];
    }
    const cleaned = value
      .replace(/^this\./i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLowerCase();
    if (!cleaned.length) {
      return [];
    }
    return cleaned
      .split(/\s+/)
      .map((word) => {
        if (word.length > 3 && word.endsWith('s')) {
          return word.slice(0, -1);
        }
        return word;
      })
      .filter(Boolean);
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
          childCandidates.length < TRACE_CHILD_EXPANSION_LIMIT * seeds.length
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
        typeof trail.lineNumber === 'number' &&
        Number.isFinite(trail.lineNumber)
          ? Math.floor(trail.lineNumber)
          : null,
      )
      .filter((line): line is number => line !== null);
    const childLines = childSummaries
      .map((child) =>
        typeof child.lineNumber === 'number' &&
        Number.isFinite(child.lineNumber)
          ? Math.floor(child.lineNumber)
          : null,
      )
      .filter((line): line is number => line !== null);
    const lineNumber =
      typeof entry.lineNumber === 'number' && Number.isFinite(entry.lineNumber)
        ? Math.floor(entry.lineNumber)
        : null;
    const searchCorpus = [summaryText, functionName, filePath, fileBase].join(
      ' ',
    );

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
    const functionWords = new Set<string>();
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
        const rawFn = match[1];
        functions.add(rawFn.toLowerCase());
        this.tokenizeFunctionName(rawFn).forEach((word) =>
          functionWords.add(word),
        );
      }

      this.tokenizeFunctionName(text).forEach((word) =>
        functionWords.add(word),
      );

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
      functionWords,
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

  private async persistChatMessages(
    sessionId: string,
    appId: string | undefined,
    entries: Array<{ role: SessionChatRole; content?: string } | undefined>,
  ): Promise<void> {
    if (!entries?.length) {
      return;
    }
    const tenantId = this.tenant.tryGetTenantId();
    if (!tenantId) {
      return;
    }
    const docs: Array<{
      tenantId: string;
      sessionId: string;
      appId?: string;
      role: SessionChatRole;
      content: string;
      tokenEstimate: number;
    }> = [];
    entries.forEach((entry) => {
      if (!entry || typeof entry.content !== 'string') {
        return;
      }
      if (!entry.content.trim().length) {
        return;
      }
      docs.push({
        tenantId,
        sessionId,
        appId,
        role: entry.role,
        content: entry.content,
        tokenEstimate: Math.ceil(entry.content.length / 4),
      });
    });
    if (!docs.length) {
      return;
    }
    try {
      await this.chatMessages.insertMany(docs, { ordered: false });
    } catch (err: any) {
      this.logger.warn(
        'Failed to persist chat transcript',
        err?.message ?? err,
      );
    }
  }
}

type ChatCollection = 'actions' | 'requests' | 'traces' | 'changes';

type ChatPlanAction = {
  actionId?: string;
  label?: string;
  labelContains?: string;
  hasReq?: boolean;
  hasDb?: boolean;
  error?: boolean;
};

type ChatPlanRequest = {
  rid?: string;
  status?: number;
};

type ChatPlanEndpoint = {
  method?: string;
  urlFragment?: string;
  exactUrl?: string;
  key?: string;
};

type ChatPlanEntryPoint = {
  fn?: string;
  file?: string;
  line?: number;
};

type ChatPlanChange = {
  collection?: string;
  op?: string;
};

type ChatPlanMongoQuery = {
  collection?: ChatCollection;
  filter?: Record<string, any>;
  limit?: number;
  sort?: Record<string, 1 | -1>;
};

type ChatQueryPlan = {
  target: ChatCollection;
  limit?: number;
  functionName?: string;
  action?: ChatPlanAction;
  request?: ChatPlanRequest;
  endpoint?: ChatPlanEndpoint;
  entryPoint?: ChatPlanEntryPoint;
  change?: ChatPlanChange;
  include?: ChatCollection[];
  reason?: string;
  mongo?: ChatPlanMongoQuery;
};

type ChatPlanCollections = Partial<Record<ChatCollection, any[]>>;

type ChatForwardSeed = {
  requests?: Array<{
    method?: string;
    url?: string;
    key?: string;
    rid?: string;
  }>;
  childFunctions?: Array<{ fn: string; file?: string; line?: number }>;
  changes?: Array<{ collection?: string; op?: string }>;
};

type ChatPlanExecution = {
  plan: ChatQueryPlan;
  collections: ChatPlanCollections;
  forwardSuggestions: string[];
};

type TraceEventLike = Record<string, any>;

type HintTokens = {
  files: Set<string>;
  fileBases: Set<string>;
  lines: Set<number>;
  functions: Set<string>;
  functionWords: Set<string>;
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
  codeRefs?: DatasetCodeRef[];
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

type RequestPayloadContext = {
  bodyPreview?: string;
  responsePreview?: string;
};

type TraceRefIndex = Record<string, { rid: string; codeRefs: CodeRef[] }>;

type CodeRef = {
  file: string;
  line?: number;
  fn?: string;
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number;
  metadata?: Record<string, any> | null;
};

type DatasetCodeRef = CodeRef & {
  rid?: string;
  actionId?: string | null;
  source: 'request' | 'trace';
};

type DatasetChunk = {
  id: string;
  index: number;
  kind: DatasetChunkKind;
  text: string;
  length: number;
  metadata?: Record<string, any>;
};

type StructuredChunk = {
  id: string;
  kind: DatasetChunkKind;
  type: SessionChunkType;
  metadata?: Record<string, any>;
  body: Record<string, any>;
};

type SessionChunkType =
  | 'SESSION_OVERVIEW'
  | 'SESSION_COUNTS'
  | 'FRONTEND_ACTION'
  | 'REQUEST'
  | 'DB_CHANGE'
  | 'TRACE_CALL'
  | 'EMAIL';

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
