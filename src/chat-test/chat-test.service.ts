import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import { QueryPlan } from './dto/chat-test.dto';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { TenantContext } from '../common/tenant/tenant-context';

const ALLOWED_COLLECTIONS = new Set([
  'actions',
  'requests',
  'traces',
  'changes',
]);

@Injectable()
export class ChatTestService {
  private readonly logger = new Logger(ChatTestService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
    private readonly tenant: TenantContext,
  ) {}

  async runQuestion(question: string): Promise<{
    raw: string;
    plan?: QueryPlan;
    model: string;
    results?: any[];
    pipeline?: any[];
    collection?: string;
    tenantId?: string;
  }> {
    const { raw, plan, model } = await this.buildQuery(question);
    if (!plan) {
      throw new BadRequestException(
        'LLM response was not valid JSON; see raw for details.',
      );
    }
    const tenantId = this.tenant.tenantId;
    const { pipeline, collection } = this.preparePipeline(plan, tenantId);
    const results = await this.executePipeline(collection, pipeline);
    return { raw, plan, model, results, pipeline, collection, tenantId };
  }

  async buildQuery(
    question: string,
  ): Promise<{ raw: string; plan?: QueryPlan; model: string }> {
    const normalized = question?.trim();
    if (!normalized) {
      throw new BadRequestException('question is required');
    }

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException(
        'OPENAI_API_KEY must be configured',
      );
    }

    const systemPrompt = this.readTemplate('ia-prompt.template');
    const userPrompt = this.readTemplate('user-prompt.template');

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${userPrompt} '${normalized}'.` },
    ];

    const model =
      this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';
    const client = new OpenAI({ apiKey });

    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 1000,
      stop: [' H:', ' AI:'],
      messages,
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    const plan = this.tryParsePlan(raw);
    return { raw, plan, model: completion.model ?? model };
  }

  private tryParsePlan(raw: string): QueryPlan | undefined {
    if (!raw) {
      return undefined;
    }

    const cleaned = raw
      .replace(/^\s*<!--\s*/, '')
      .replace(/\s*--!?>\s*$/, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      this.logger.warn(
        `Failed to parse chat-test response as JSON: ${String(err)}`,
      );
      return undefined;
    }
  }

  private preparePipeline(
    plan: QueryPlan,
    tenantId: string,
  ): { pipeline: any[]; collection: string } {
    const collection = plan?.meta?.collection?.trim();
    if (!collection || !ALLOWED_COLLECTIONS.has(collection)) {
      throw new BadRequestException(
        `Target collection must be one of ${Array.from(ALLOWED_COLLECTIONS).join(', ')}`,
      );
    }

    const pipeline = this.normalizePipeline(plan?.query);
    const hasTenantMatch = pipeline.some(
      (stage) =>
        stage &&
        typeof stage === 'object' &&
        ('$match' in stage ? stage.$match?.tenantId !== undefined : false),
    );
    const pipelineWithTenant = hasTenantMatch
      ? pipeline
      : [{ $match: { tenantId } }, ...pipeline];

    return { pipeline: pipelineWithTenant, collection };
  }

  private normalizePipeline(query: any): any[] {
    if (Array.isArray(query)) {
      query.forEach((stage, idx) => {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
          throw new BadRequestException(
            `Pipeline stage at index ${idx} must be an object`,
          );
        }
      });
      return query;
    }

    if (typeof query === 'string') {
      try {
        const parsed = JSON.parse(query);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`Failed to parse string pipeline: ${String(err)}`);
      }
    }

    throw new BadRequestException('LLM returned a non-array query pipeline.');
  }

  private async executePipeline(collection: string, pipeline: any[]) {
    try {
      const cursor = this.connection
        .collection(collection)
        .aggregate(pipeline, { allowDiskUse: true });
      return await cursor.toArray();
    } catch (err) {
      this.logger.error(
        `Failed to run aggregate on ${collection}: ${String(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to execute generated aggregate pipeline',
      );
    }
  }

  private readTemplate(filename: string): string {
    const filePath = join(__dirname, 'templates', filename);
    return readFileSync(filePath, 'utf8');
  }
}
