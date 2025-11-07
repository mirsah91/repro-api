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
import { TenantContext } from '../common/tenant/tenant-context';
import {
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from './utils/session-data-crypto';

const STRING_TRUNCATION_LENGTH = 4000;

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
    let usage:
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        }
      | undefined;

    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.25,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content:
              'You are a senior observability analyst. Write concise but comprehensive reports that help technical people understand user impact and give developers specific technical insights. The summary should look like a technical document.',
          },
          ...this.normalizeHintMessages(opts?.hintMessages),
          {
            role: 'user',
            content: [
              'Create a session report with the following structure:',
              '1. Executive Overview (plain language for non-technical readers).',
              '2. Detailed Technical Findings (reference concrete actions, requests, DB changes, emails, and traces).',
              '3. Issues & Anomalies (include errors, failures, slow operations).',
              '',
              'Emphasize timelines, performance metrics, and user impact. Tie together correlated events (e.g., which action triggered a request or DB change). Do not suggest any further actions.',
              '',
              'Session dataset:',
              '```json',
              dataset.serialized,
              '```',
            ].join('\n'),
          },
        ],
      });

      summary =
        completion.choices?.[0]?.message?.content?.trim() ??
        'No summary returned.';
      usage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined;
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
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content:
              'You are a senior observability analyst answering questions about a single session. Base every response solely on the provided dataset. Reference actions, requests, DB changes, emails, and traces when relevant. If the dataset lacks the answer, say you cannot find it.',
          },
          ...conversation,
          {
            role: 'system',
            content: [
              'Session dataset:',
              '```json',
              dataset.serialized,
              '```',
            ].join('\n'),
          },
        ],
      });

      reply =
        completion.choices?.[0]?.message?.content?.trim() ??
        'No response generated.';
      usage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined;
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

    const payload = {
      session: this.sanitize(sessionDoc),
      timeline: {
        actions: scopedTimeline.actions,
        requests: scopedTimeline.requests,
        traces: scopedTimeline.traces,
        dbChanges,
        emails,
      },
    };

    const serialized = JSON.stringify(payload, this.promptReplacer, 2);

    return {
      serialized,
      counts: {
        actions: actions.length,
        requests: requests.length,
        dbChanges: dbChanges.length,
        emails: emails.length,
        traces: traces.length,
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

  private scopeTimelineCollections<TAction, TRequest, TTrace>(
    actions: TAction[],
    requests: TRequest[],
    traces: TTrace[],
    hintMessages: HintMessageParam[] = [],
  ): { actions: TAction[]; requests: TRequest[]; traces: TTrace[] } {
    const tokens = this.extractHintTokens(hintMessages);
    const prioritizedTraces = this.rankTracesByHints(traces, tokens);

    const scopedTraces = prioritizedTraces.length
      ? prioritizedTraces
      : this.sampleEvenly(traces, 25);

    const prioritizedRequestIds = new Set(
      prioritizedTraces
        .map((trace: any) => this.resolveRequestId(trace))
        .filter((rid): rid is string => Boolean(rid)),
    );

    const scopedRequests = prioritizedRequestIds.size
      ? this.composePrioritizedRequests(
          requests,
          prioritizedRequestIds,
          tokens,
        )
      : this.sampleEvenly(requests, 8);

    return {
      actions,
      requests: scopedRequests,
      traces: scopedTraces,
    };
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

  private extractHintTokens(messages: HintMessageParam[]): HintTokens {
    const files = new Set<string>();
    const fileBases = new Set<string>();
    const lines = new Set<number>();
    const functions = new Set<string>();

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
    }

    return {
      files,
      fileBases,
      lines,
      functions,
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

type TraceEventLike = {
  fn?: string | null;
  file?: string | null;
  line?: number | null;
};

type HintTokens = {
  files: Set<string>;
  fileBases: Set<string>;
  lines: Set<number>;
  functions: Set<string>;
  hasDirectHints: boolean;
};

type HintMessageParam = {
  role?: string | null;
  content?: any;
};

type SessionDataset = {
  serialized: string;
  counts: Record<string, number>;
};
