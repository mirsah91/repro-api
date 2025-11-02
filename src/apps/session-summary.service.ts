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
import { Session } from '../sessions/schemas/session.schema';
import { Action } from '../sessions/schemas/action.schema';
import { RequestEvt } from '../sessions/schemas/request.schema';
import { DbChange } from '../sessions/schemas/db-change.schema';
import { EmailEvt } from '../sessions/schemas/emails.schema';
import { TraceEvt } from '../sessions/schemas/trace.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  hydrateChangeDoc,
  hydrateEmailDoc,
  hydrateRequestDoc,
} from '../sessions/utils/session-data-crypto';

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
    opts?: { appId?: string },
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

    const q = this.tenantFilter({
          _id: sessionId,
          ...(opts?.appId ? { appId: opts.appId } : {}),
        });

    console.log('query ==>', JSON.stringify(q))
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

    const payload = {
      session: this.sanitize(sessionDoc),
      timeline: {
        actions,
        requests,
        dbChanges,
        emails,
        traces,
      },
    };

    const serialized = JSON.stringify(payload, this.promptReplacer, 2);

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
              serialized,
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
      counts: {
        actions: actions.length,
        requests: requests.length,
        dbChanges: dbChanges.length,
        emails: emails.length,
        traces: traces.length,
      },
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
      )}… [truncated for prompt length]`;
    }
    return value;
  }

  private tenantFilter<T extends Record<string, any>>(criteria: T): T & {
    tenantId: string;
  } {
    return { ...criteria, tenantId: this.tenant.tenantId };
  }
}
