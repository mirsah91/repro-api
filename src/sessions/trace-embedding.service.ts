import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { Pinecone, Index } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { TraceSummary } from './schemas/trace-summary.schema';

type TraceSegmentEvent = Record<string, any>;

type TraceBatchPayload = {
  tenantId: string;
  sessionId: string;
  requestRid?: string | null;
  actionId?: string | null;
  traceId?: string | null;
  batchIndex: number;
  totalBatches?: number | null;
  events: TraceSegmentEvent[];
};

type PineconeVectorRecord = {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean>;
};

@Injectable()
export class TraceEmbeddingService {
  private readonly logger = new Logger(TraceEmbeddingService.name);
  private openai?: OpenAI;
  private pinecone?: Pinecone;
  private pineconeIndex?: Index<Record<string, string | number | boolean>>;
  private pineconeNamespaceClient?: Index<
    Record<string, string | number | boolean>
  >;
  private openAiWarned = false;
  private pineconeWarned = false;
  private vectorSizeWarned = false;

  constructor(
    @InjectModel(TraceSummary.name)
    private readonly traceSummaries: Model<TraceSummary>,
    private readonly config: ConfigService,
  ) {}

  private get useIntegratedIngest(): boolean {
    return (
      this.config
        .get<string>('PINECONE_INTEGRATED_MODE')
        ?.trim()
        .toLowerCase() === 'true'
    );
  }

  async processTraceBatch(payload: TraceBatchPayload): Promise<void> {
    if (!Array.isArray(payload.events) || !payload.events.length) {
      return;
    }

    const chunkSize = this.getChunkSize();
    const groupId = this.buildGroupId(payload);
    let segmentOffset = 0;

    for (let i = 0; i < payload.events.length; i += chunkSize) {
      const segmentEvents = payload.events.slice(i, i + chunkSize);
      if (!segmentEvents.length) {
        continue;
      }

      const segmentIndex = payload.batchIndex * 1000 + segmentOffset;
      const eventStart = segmentIndex * chunkSize;
      const eventEnd = eventStart + segmentEvents.length - 1;
      const summary = this.buildSegmentSummary(segmentEvents, {
        sessionId: payload.sessionId,
        requestRid: payload.requestRid ?? undefined,
        actionId: payload.actionId ?? undefined,
        batchIndex: payload.batchIndex,
        segmentIndex,
      });

      if (!summary) {
        segmentOffset += 1;
        continue;
      }

      const previewEvents = this.buildPreview(segmentEvents);
      const segmentHash = this.hashSegment(
        payload.sessionId,
        groupId,
        segmentIndex,
        summary,
      );

      await this.traceSummaries.updateOne(
        {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          groupId,
          segmentIndex,
        },
        {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          groupId,
          requestRid: payload.requestRid ?? null,
          actionId: payload.actionId ?? null,
          traceId: payload.traceId ?? null,
          segmentIndex,
          eventStart,
          eventEnd,
          eventCount: segmentEvents.length,
          summary,
          segmentHash,
          model: this.getEmbeddingModel(),
          previewEvents,
        },
        { upsert: true },
      );

      const baseRecord = {
        id: this.buildRecordId(payload, groupId, segmentIndex, segmentHash),
        summary,
        metadata: this.buildRecordMetadata(
          payload,
          groupId,
          segmentIndex,
          eventStart,
          eventEnd,
          segmentEvents.length,
        ),
      };

      if (this.useIntegratedIngest) {
        await this.upsertIntegratedRecord(baseRecord);
      } else {
        const embedding = await this.createEmbedding(summary);
        if (embedding) {
          await this.upsertVectorRecord({
            id: baseRecord.id,
            values: embedding,
            metadata: baseRecord.metadata,
          });
        }
      }

      segmentOffset += 1;
    }
  }

  private buildGroupId(payload: TraceBatchPayload): string {
    return (
      payload.requestRid ??
      payload.actionId ??
      payload.traceId ??
      payload.sessionId
    );
  }

  private getChunkSize(): number {
    const raw = Number(this.config.get<string>('TRACE_EMBED_CHUNK_SIZE'));
    if (Number.isFinite(raw) && raw >= 5 && raw <= 200) {
      return Math.floor(raw);
    }
    return 40;
  }

  private getEmbeddingModel(): string {
    return (
      this.config.get<string>('OPENAI_EMBEDDINGS_MODEL')?.trim() ??
      'text-embedding-3-large'
    );
  }

  private buildSegmentSummary(
    events: TraceSegmentEvent[],
    context: {
      sessionId: string;
      requestRid?: string;
      actionId?: string;
      batchIndex: number;
      segmentIndex: number;
    },
  ): string {
    const headerParts = [
      `Session ${context.sessionId}`,
      typeof context.batchIndex === 'number'
        ? `batch ${context.batchIndex}`
        : null,
      typeof context.segmentIndex === 'number'
        ? `segment ${context.segmentIndex}`
        : null,
      context.requestRid ? `request ${context.requestRid}` : null,
      context.actionId ? `action ${context.actionId}` : null,
    ].filter(Boolean);

    const lines = events.slice(0, 25).map((event, idx) => {
      const fn = this.toText(event.fn);
      const file = this.compactFilePath(this.toText(event.file));
      const line = this.formatLine(event.line);
      const type = this.toText(event.type);
      const args = this.formatPayload(event.args ?? event.arguments);
      const result = this.formatPayload(event.result ?? event.retVal);
      const duration = this.formatDuration(event.dur ?? event.durationMs);

      const descriptor = [
        fn,
        file || line ? `(${[file, line].filter(Boolean).join(':')})` : null,
        type ? `[${type}]` : null,
      ]
        .filter(Boolean)
        .join(' ');

      const extras = [
        args ? `args=${args}` : null,
        result ? `result=${result}` : null,
        duration ? `dur=${duration}` : null,
      ]
        .filter(Boolean)
        .join(' ');

      return `${idx + 1}. ${descriptor}${extras ? ` ${extras}` : ''}`;
    });

    const summary = [headerParts.join(' | '), ...lines]
      .filter(Boolean)
      .join('\n');

    return summary.slice(0, 2000);
  }

  private toText(value: any): string {
    if (!value) return '';
    return String(value).trim();
  }

  private compactFilePath(file: string): string {
    if (!file) return '';
    const normalized = file.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts.slice(-3).join('/');
  }

  private formatLine(line: any): string {
    const num = Number(line);
    return Number.isFinite(num) && num >= 0 ? String(Math.floor(num)) : '';
  }

  private formatPayload(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }
    try {
      const text = JSON.stringify(value);
      return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    } catch {
      const text = String(value);
      return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    }
  }

  private formatDuration(value: any): string {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return '';
    }
    return `${Math.max(0, Math.round(num))}ms`;
  }

  private buildPreview(events: TraceSegmentEvent[]) {
    return events.slice(0, 5).map((event) => ({
      fn: this.toText(event.fn) || null,
      file: this.toText(event.file) || null,
      line: Number.isFinite(Number(event.line))
        ? Number(event.line)
        : null,
      type: this.toText(event.type) || null,
    }));
  }

  private hashSegment(
    sessionId: string,
    groupId: string,
    segmentIndex: number,
    summary: string,
  ): string {
    return createHash('sha256')
      .update(sessionId)
      .update(groupId)
      .update(String(segmentIndex))
      .update(summary)
      .digest('hex');
  }

  private async upsertIntegratedRecord(record: {
    id: string;
    summary: string;
    metadata: Record<string, string | number | boolean>;
  }): Promise<void> {
    const namespaceClient = await this.ensurePineconeNamespaceClient();
    if (!namespaceClient) {
      return;
    }
    try {
      await namespaceClient.upsertRecords([
        {
          _id: record.id,
          chunk_text: record.summary,
          ...record.metadata,
        },
      ]);
    } catch (err: any) {
      this.logger.warn(
        `Pinecone upsert failed: ${err?.message ?? 'unknown error'}`,
      );
    }
  }

  private buildRecordId(
    payload: TraceBatchPayload,
    groupId: string,
    segmentIndex: number,
    segmentHash: string,
  ): string {
    return [
      payload.tenantId,
      payload.sessionId,
      groupId,
      segmentIndex,
      segmentHash.slice(0, 8),
    ]
      .filter(Boolean)
      .join(':');
  }

  private buildRecordMetadata(
    payload: TraceBatchPayload,
    groupId: string,
    segmentIndex: number,
    eventStart: number,
    eventEnd: number,
    eventCount: number,
  ): Record<string, string | number | boolean> {
    const metadata: Record<string, string | number | boolean> = {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      groupId,
      segmentIndex,
      batchIndex: payload.batchIndex,
      eventStart,
      eventEnd,
      eventCount,
    };
    if (payload.requestRid) metadata.requestRid = payload.requestRid;
    if (payload.actionId) metadata.actionId = payload.actionId;
    if (payload.totalBatches != null) {
      metadata.totalBatches = payload.totalBatches;
    }
    return metadata;
  }

  private async upsertVectorRecord(record: PineconeVectorRecord): Promise<void> {
    const namespaceClient = await this.ensurePineconeNamespaceClient();
    if (!namespaceClient) {
      return;
    }
    try {
      const values = this.normalizeVector(record.values);
      await namespaceClient.upsert([
        {
          id: record.id,
          values,
          metadata: record.metadata,
        },
      ]);
    } catch (err: any) {
      this.logger.warn(
        `Pinecone upsert failed: ${err?.message ?? 'unknown error'}`,
      );
    }
  }

  private async ensurePineconeNamespaceClient(): Promise<
    Index<Record<string, string | number | boolean>> | null
  > {
    if (this.pineconeNamespaceClient) {
      return this.pineconeNamespaceClient;
    }

    const indexClient = await this.ensurePineconeIndex();
    if (!indexClient) {
      return null;
    }

    const namespaceEnv = this.config.get<string>('PINECONE_NAMESPACE')?.trim();
    this.pineconeNamespaceClient = namespaceEnv?.length
      ? indexClient.namespace(namespaceEnv)
      : indexClient;
    return this.pineconeNamespaceClient;
  }

  private async createEmbedding(text: string): Promise<number[] | null> {
    if (!text) {
      return null;
    }
    const client = this.ensureOpenAI();
    if (!client) {
      return null;
    }
    try {
      const result = await client.embeddings.create({
        model: this.getEmbeddingModel(),
        input: text,
      });
      return result.data?.[0]?.embedding ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Failed to create embedding: ${err?.message ?? 'unknown error'}`,
      );
      return null;
    }
  }

  private ensureOpenAI(): OpenAI | null {
    if (this.openai) {
      return this.openai;
    }
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      if (!this.openAiWarned) {
        this.logger.warn(
          'Trace embeddings disabled: OPENAI_API_KEY is not configured (set PINECONE_INTEGRATED_MODE=true to skip embeddings).',
        );
        this.openAiWarned = true;
      }
      return null;
    }
    this.openai = new OpenAI({ apiKey });
    return this.openai;
  }

  private normalizeVector(values: number[]): number[] {
    const target = Number(this.config.get<string>('PINECONE_INDEX_DIMENSION'));
    if (!Number.isFinite(target) || target <= 0) {
      return values;
    }
    if (values.length === target) {
      return values;
    }
    if (!this.vectorSizeWarned) {
      this.logger.warn(
        `Adjusting embedding vector length from ${values.length} to ${target} to satisfy Pinecone index dimension. Consider setting PINECONE_INDEX_DIMENSION to match your index or recreating the index.`,
      );
      this.vectorSizeWarned = true;
    }
    if (values.length > target) {
      return values.slice(0, target);
    }
    const padded = values.slice();
    while (padded.length < target) {
      padded.push(0);
    }
    return padded;
  }

  private async ensurePineconeIndex(): Promise<
    Index<Record<string, string | number | boolean>> | null
  > {
    if (this.pineconeIndex) {
      return this.pineconeIndex;
    }

    const apiKey = this.config.get<string>('PINECONE_API_KEY')?.trim();
    const providedIndexName =
      this.config.get<string>('PINECONE_INDEX')?.trim() ?? undefined;
    const dataHost = this.resolvePineconeDataHost();
    const indexName =
      providedIndexName ?? this.deriveIndexNameFromHost(dataHost ?? '');

    if (!apiKey) {
      if (!this.pineconeWarned) {
        this.logger.warn(
          'Trace embeddings disabled: PINECONE_API_KEY is not configured.',
        );
        this.pineconeWarned = true;
      }
      return null;
    }

    if (!indexName) {
      if (!this.pineconeWarned) {
        this.logger.warn(
          'Trace embeddings disabled: configure PINECONE_INDEX (or provide PINECONE_HOST so the index can be inferred).',
        );
        this.pineconeWarned = true;
      }
      return null;
    }

    if (!dataHost) {
      if (!this.pineconeWarned) {
        this.logger.warn(
          'Trace embeddings disabled: set PINECONE_HOST (index data plane URL).',
        );
        this.pineconeWarned = true;
      }
      return null;
    }

    if (!this.pinecone) {
      const controllerHostRaw =
        this.config.get<string>('PINECONE_CONTROLLER_HOST')?.trim() ?? '';
      const controllerHost =
        controllerHostRaw && controllerHostRaw.length
          ? controllerHostRaw
          : undefined;

      if (
        controllerHost &&
        controllerHost.includes('.svc.') &&
        !this.pineconeWarned
      ) {
        this.logger.warn(
          [
            'PINECONE_CONTROLLER_HOST looks like a data-plane host.',
            'Set that value via PINECONE_HOST (for vector traffic) and leave PINECONE_CONTROLLER_HOST empty or https://api.pinecone.io so index metadata can be resolved automatically.',
          ].join(' '),
        );
        this.pineconeWarned = true;
      }

      this.pinecone = new Pinecone(
        controllerHost ? { apiKey, controllerHostUrl: controllerHost } : { apiKey },
      );
    }

    this.pineconeIndex = this.pinecone.index(indexName, dataHost);
    this.pineconeWarned = false;
    return this.pineconeIndex;
  }

  private resolvePineconeDataHost(): string | undefined {
    const explicit = this.config.get<string>('PINECONE_HOST')?.trim();
    if (explicit) {
      return explicit.endsWith('/') ? explicit.slice(0, -1) : explicit;
    }
    const index = this.config.get<string>('PINECONE_INDEX')?.trim();
    const project = this.config.get<string>('PINECONE_PROJECT_ID')?.trim();
    const environment = this.config.get<string>('PINECONE_ENVIRONMENT')?.trim();
    if (index && project && environment) {
      return `https://${index}-${project}.svc.${environment}.pinecone.io`;
    }
    return undefined;
  }

  private deriveIndexNameFromHost(host?: string): string | undefined {
    if (!host) {
      return undefined;
    }
    const sanitized = host.replace(/^https?:\/\//, '').trim();
    if (!sanitized.length) {
      return undefined;
    }
    const match = sanitized.match(
      /^([a-z0-9-]+?)-[a-z0-9]{6,}\.svc\.[a-z0-9-]+\.[a-z]+$/i,
    );
    if (match?.[1]) {
      return match[1];
    }
    const firstSegment = sanitized.split('.')[0];
    return firstSegment || undefined;
  }
}
