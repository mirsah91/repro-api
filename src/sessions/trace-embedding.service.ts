import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { Pinecone, Index } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { TraceSummary } from './schemas/trace-summary.schema';
import { TraceNode } from './schemas/trace-node.schema';

const FUNCTION_LINEAGE_LIMIT = 6;
const FUNCTION_CHILD_LIMIT = 6;
const FUNCTION_EVENT_SAMPLE_LIMIT = 40;
const FUNCTION_PAYLOAD_PREVIEW_LIMIT = 400;

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

type LineageEntry = {
  chunkId: string;
  functionName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  depth: number;
  relation: 'self' | 'parent';
};

type ChildSummary = {
  chunkId: string;
  functionName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  depth: number;
};

type TraceSegmentDescriptor = {
  segmentIndex: number;
  summary: string;
  eventStart: number;
  eventEnd: number;
  eventCount: number;
  previewEvents: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;
  chunkId?: string;
  parentChunkId?: string | null;
  chunkKind: 'function' | 'legacy';
  depth?: number | null;
  lineagePath?: string | null;
  lineageTrail?: LineageEntry[];
  childChunkIds?: string[];
  childSummaries?: ChildSummary[];
  functionName?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  nodeRef?: FunctionCallNode;
};

type FunctionCallNode = {
  localId: string;
  fn?: string;
  file?: string;
  line?: number;
  depth: number;
  parent?: FunctionCallNode | null;
  children: FunctionCallNode[];
  events: TraceSegmentEvent[];
  eventStart: number;
  eventEnd: number;
  chunkId?: string;
  lineageTrail?: LineageEntry[];
  lineagePath?: string;
  childSummaries?: ChildSummary[];
  argsPreview?: string;
  resultPreview?: string;
  durationMs?: number | null;
  metadata?: Array<{ key: string; value: string }>;
};

type SegmentBuildContext = {
  sessionId: string;
  groupId: string;
  requestRid?: string | null;
  actionId?: string | null;
  batchIndex: number;
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
    @InjectModel(TraceNode.name)
    private readonly traceNodes: Model<TraceNode>,
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

    const groupId = this.buildGroupId(payload);
    const chunkSize = this.getChunkSize();
    const context: SegmentBuildContext = {
      sessionId: payload.sessionId,
      groupId,
      requestRid: payload.requestRid ?? null,
      actionId: payload.actionId ?? null,
      batchIndex: payload.batchIndex,
    };

    const segments = this.buildFunctionSegments(payload.events, context);
    const resolvedSegments =
      segments.length > 0
        ? segments
        : this.buildLegacySegments(payload.events, context, chunkSize);

    for (const segment of resolvedSegments) {
      if (!segment.summary) {
        continue;
      }

      const segmentHash = this.hashSegment(
        payload.sessionId,
        groupId,
        segment.segmentIndex,
        segment.summary,
      );

      await this.traceSummaries.updateOne(
        {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          groupId,
          segmentIndex: segment.segmentIndex,
        },
        {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          groupId,
          requestRid: payload.requestRid ?? null,
          actionId: payload.actionId ?? null,
          traceId: payload.traceId ?? null,
          segmentIndex: segment.segmentIndex,
          eventStart: segment.eventStart,
          eventEnd: segment.eventEnd,
          eventCount: segment.eventCount,
          summary: segment.summary,
          segmentHash,
          model: this.getEmbeddingModel(),
          previewEvents: segment.previewEvents,
          chunkId: segment.chunkId ?? null,
          parentChunkId: segment.parentChunkId ?? null,
          chunkKind: segment.chunkKind,
          depth:
            typeof segment.depth === 'number' && Number.isFinite(segment.depth)
              ? segment.depth
              : null,
          childChunkIds:
            segment.childChunkIds && segment.childChunkIds.length
              ? segment.childChunkIds
              : [],
          lineagePath: segment.lineagePath ?? null,
          lineageTrail: segment.lineageTrail ?? null,
          childSummaries: segment.childSummaries ?? null,
          functionName: segment.functionName ?? null,
          filePath: segment.filePath ?? null,
          lineNumber:
            typeof segment.lineNumber === 'number' &&
            Number.isFinite(segment.lineNumber)
              ? segment.lineNumber
              : null,
        },
        { upsert: true },
      );

      if (segment.chunkKind === 'function') {
        await this.upsertTraceNodeDocument(payload, groupId, segment);
      }

      const baseRecord = {
        id: this.buildRecordId(
          payload,
          groupId,
          segment.segmentIndex,
          segmentHash,
        ),
        summary: segment.summary,
        metadata: this.buildRecordMetadata(payload, groupId, segment),
      };

      if (this.useIntegratedIngest) {
        await this.upsertIntegratedRecord(baseRecord);
      } else {
        const embedding = await this.createEmbedding(segment.summary);
        if (embedding) {
          await this.upsertVectorRecord({
            id: baseRecord.id,
            values: embedding,
            metadata: baseRecord.metadata,
          });
        }
      }
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

  private async upsertTraceNodeDocument(
    payload: TraceBatchPayload,
    groupId: string,
    segment: TraceSegmentDescriptor,
  ): Promise<void> {
    if (!segment.chunkId || !segment.nodeRef) {
      return;
    }
    const doc = {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      chunkId: segment.chunkId,
      groupId,
      requestRid: payload.requestRid ?? null,
      actionId: payload.actionId ?? null,
      batchIndex: payload.batchIndex ?? null,
      parentChunkId: segment.parentChunkId ?? null,
      childChunkIds: segment.childChunkIds ?? [],
      functionName: segment.functionName ?? null,
      filePath: segment.filePath ?? null,
      lineNumber:
        typeof segment.lineNumber === 'number' &&
        Number.isFinite(segment.lineNumber)
          ? segment.lineNumber
          : null,
      depth:
        typeof segment.depth === 'number' && Number.isFinite(segment.depth)
          ? segment.depth
          : null,
      argsPreview: segment.nodeRef.argsPreview ?? null,
      resultPreview: segment.nodeRef.resultPreview ?? null,
      durationMs:
        typeof segment.nodeRef.durationMs === 'number'
          ? segment.nodeRef.durationMs
          : null,
      eventStart: segment.eventStart ?? null,
      eventEnd: segment.eventEnd ?? null,
      sampleEvents: segment.previewEvents ?? [],
      metadata: segment.nodeRef.metadata ?? [],
    };

    await this.traceNodes
      .updateOne(
        {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          chunkId: segment.chunkId,
        },
        doc,
        { upsert: true },
      )
      .catch((err) => {
        this.logger.warn(
          `Failed to upsert trace node ${segment.chunkId}: ${
            err?.message ?? err
          }`,
        );
      });
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
      const fn = this.extractEventFn(event) ?? this.toText(event.fn);
      const file = this.extractEventFile(event) ?? '';
      const line = this.formatLine(this.extractEventLine(event));
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

  private buildFunctionSegments(
    events: TraceSegmentEvent[],
    context: SegmentBuildContext,
  ): TraceSegmentDescriptor[] {
    if (!Array.isArray(events) || !events.length) {
      return [];
    }
    const nodes = this.buildFunctionCallNodes(events);
    if (!nodes.length) {
      return [];
    }

    nodes.forEach((node, idx) => {
      node.chunkId = this.hashFunctionChunk(context, node, idx);
    });

    nodes.forEach((node) => {
      node.lineageTrail = this.buildLineageTrail(node);
      node.lineagePath = node.lineageTrail
        ? node.lineageTrail.map((entry) => entry.chunkId).join('>')
        : undefined;
      node.childSummaries = this.buildChildSummaries(node);
    });

    const offset = context.batchIndex * 1000;
    return nodes.map((node, idx) => ({
      segmentIndex: offset + idx,
      summary: this.buildFunctionChunkSummary(node, context, idx, nodes.length),
      eventStart: node.eventStart,
      eventEnd: node.eventEnd,
      eventCount: Math.max(node.events.length, 1),
      previewEvents: this.buildPreview(node.events),
      chunkId: node.chunkId,
      parentChunkId: node.parent?.chunkId ?? null,
      chunkKind: 'function',
      depth: node.depth,
      lineagePath: node.lineagePath ?? null,
      lineageTrail: node.lineageTrail ?? [],
      childChunkIds: node.children
        .map((child) => child.chunkId)
        .filter((id): id is string => Boolean(id)),
      childSummaries: node.childSummaries ?? [],
      functionName: node.fn ?? null,
      filePath: node.file ?? null,
      lineNumber:
        typeof node.line === 'number' && Number.isFinite(node.line)
          ? node.line
          : null,
      nodeRef: node,
    }));
  }

  private buildLegacySegments(
    events: TraceSegmentEvent[],
    context: SegmentBuildContext,
    chunkSize: number,
  ): TraceSegmentDescriptor[] {
    if (!Array.isArray(events) || !events.length) {
      return [];
    }
    const segments: TraceSegmentDescriptor[] = [];
    let segmentOffset = 0;
    for (let i = 0; i < events.length; i += chunkSize) {
      const segmentEvents = events.slice(i, i + chunkSize);
      if (!segmentEvents.length) {
        segmentOffset += 1;
        continue;
      }
      const segmentIndex = context.batchIndex * 1000 + segmentOffset;
      const summary = this.buildSegmentSummary(segmentEvents, {
        sessionId: context.sessionId,
        requestRid: context.requestRid ?? undefined,
        actionId: context.actionId ?? undefined,
        batchIndex: context.batchIndex,
        segmentIndex,
      });
      if (!summary) {
        segmentOffset += 1;
        continue;
      }
      const eventStart = segmentIndex * chunkSize;
      const eventEnd = eventStart + segmentEvents.length - 1;
      segments.push({
        segmentIndex,
        summary,
        eventStart,
        eventEnd,
        eventCount: segmentEvents.length,
        previewEvents: this.buildPreview(segmentEvents),
        chunkKind: 'legacy',
      });
      segmentOffset += 1;
    }
    return segments;
  }

  private buildFunctionCallNodes(
    events: TraceSegmentEvent[],
  ): FunctionCallNode[] {
    if (!Array.isArray(events) || !events.length) {
      return [];
    }
    const nodes: FunctionCallNode[] = [];
    const stack: FunctionCallNode[] = [];
    const openById = new Map<string, FunctionCallNode>();
    const syntheticIndex = new Map<string, number>();

    for (let idx = 0; idx < events.length; idx += 1) {
      const event = events[idx] ?? {};
      const typeText = this.toText(event.type).toLowerCase();
      const identifier = this.extractEventIdentifier(event);

      if (this.isExitEvent(typeText)) {
        const node =
          (identifier ? openById.get(identifier) : undefined) ??
          this.findNodeInStackById(stack, identifier) ??
          stack.pop();
        if (node) {
          node.eventEnd = idx;
          node.events.push(event);
          this.enrichNodeFromEvent(node, event);
          if (identifier) {
            openById.delete(identifier);
            this.detachNodeFromStack(stack, node);
          }
        }
        continue;
      }

      const descriptor = this.extractFunctionDescriptor(event);
      const isEnter = this.isEnterEvent(typeText);
      const parent = stack[stack.length - 1];
      if (!isEnter && !descriptor.fn && !parent) {
        continue;
      }

      if (isEnter || descriptor.fn) {
        const resolvedLine =
          typeof descriptor.line === 'number' &&
          Number.isFinite(descriptor.line)
            ? descriptor.line
            : this.extractEventLine(event);

        const localId =
          identifier ??
          this.buildSyntheticNodeId(
            descriptor.fn ?? this.extractEventFn(event) ?? 'fn',
            descriptor.file ?? this.extractEventFile(event) ?? '',
            resolvedLine ?? idx,
            idx,
            syntheticIndex,
          );
        const node: FunctionCallNode = {
          localId,
          fn:
            descriptor.fn ||
            this.extractEventFn(event) ||
            parent?.fn ||
            'anonymous',
          file: descriptor.file || this.extractEventFile(event) || parent?.file,
          line: resolvedLine ?? parent?.line,
          depth: parent ? parent.depth + 1 : 0,
          parent: parent ?? null,
          children: [],
          events: [event],
          eventStart: idx,
          eventEnd: idx,
          metadata: [],
        };
        this.enrichNodeFromEvent(node, event);
        nodes.push(node);
        if (parent) {
          parent.children.push(node);
        }
        stack.push(node);
        if (identifier) {
          openById.set(identifier, node);
        }
        continue;
      }

      if (parent) {
        parent.events.push(event);
        this.enrichNodeFromEvent(parent, event);
      }
    }

    const lastIndex = events.length ? events.length - 1 : 0;
    while (stack.length) {
      const node = stack.pop()!;
      if (node.eventEnd < node.eventStart) {
        node.eventEnd = lastIndex;
      }
      const lastEvent = node.events[node.events.length - 1];
      if (lastEvent) {
        this.enrichNodeFromEvent(node, lastEvent);
      }
    }
    return nodes;
  }

  private buildFunctionChunkSummary(
    node: FunctionCallNode,
    context: SegmentBuildContext,
    index: number,
    total: number,
  ): string {
    const fn = node.fn ?? 'anonymous';
    const fileRef = node.file
      ? `${node.file}${node.line ? `:${node.line}` : ''}`
      : 'unknown file';
    const headerParts = [
      `Session ${context.sessionId}`,
      `segment ${index + 1}/${total}`,
      typeof context.batchIndex === 'number'
        ? `batch ${context.batchIndex}`
        : null,
      context.requestRid ? `request ${context.requestRid}` : null,
      context.actionId ? `action ${context.actionId}` : null,
      `function ${fn}`,
      `depth ${node.depth}`,
    ].filter(Boolean);

    const ancestorTrail = (node.lineageTrail ?? [])
      .filter((entry) => entry.relation === 'parent')
      .map((entry) =>
        [
          `  - ${entry.functionName ?? 'fn'}`,
          entry.filePath
            ? `(${entry.filePath}${entry.lineNumber ? `:${entry.lineNumber}` : ''})`
            : '',
          `(depth ${entry.depth})`,
        ]
          .filter(Boolean)
          .join(' '),
      )
      .join('\n');

    const childTrail = (node.childSummaries ?? [])
      .slice(0, FUNCTION_CHILD_LIMIT)
      .map((entry) =>
        [
          `  - ${entry.functionName ?? 'fn'}`,
          entry.filePath
            ? `(${entry.filePath}${entry.lineNumber ? `:${entry.lineNumber}` : ''})`
            : '',
          `(depth ${entry.depth})`,
        ]
          .filter(Boolean)
          .join(' '),
      )
      .join('\n');

    const lines = node.events
      .slice(0, FUNCTION_EVENT_SAMPLE_LIMIT)
      .map((event, idx) => this.describeFunctionEvent(event, idx));

    return [
      headerParts.join(' | '),
      `file: ${fileRef}`,
      `events captured: ${node.events.length}`,
      ancestorTrail ? `ancestors:\n${ancestorTrail}` : undefined,
      childTrail ? `children:\n${childTrail}` : undefined,
      'event samples:',
      ...lines,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildLineageTrail(node: FunctionCallNode): LineageEntry[] {
    const trail: LineageEntry[] = [];
    const stack: FunctionCallNode[] = [];
    let cursor: FunctionCallNode | null | undefined = node;
    while (cursor && stack.length < FUNCTION_LINEAGE_LIMIT) {
      stack.push(cursor);
      cursor = cursor.parent;
    }
    stack.reverse();
    for (let i = 0; i < stack.length; i += 1) {
      const entry = stack[i];
      if (!entry.chunkId) {
        continue;
      }
      trail.push({
        chunkId: entry.chunkId,
        functionName: entry.fn ?? null,
        filePath: entry.file ?? null,
        lineNumber:
          typeof entry.line === 'number' && Number.isFinite(entry.line)
            ? entry.line
            : null,
        depth: entry.depth,
        relation: i === stack.length - 1 ? 'self' : 'parent',
      });
    }
    return trail;
  }

  private buildChildSummaries(node: FunctionCallNode): ChildSummary[] {
    if (!node.children?.length) {
      return [];
    }
    const summaries: ChildSummary[] = [];
    for (const child of node.children.slice(0, FUNCTION_CHILD_LIMIT)) {
      if (!child.chunkId) {
        continue;
      }
      summaries.push({
        chunkId: child.chunkId,
        functionName: child.fn ?? null,
        filePath: child.file ?? null,
        lineNumber:
          typeof child.line === 'number' && Number.isFinite(child.line)
            ? child.line
            : null,
        depth: child.depth,
      });
    }
    return summaries;
  }

  private hashFunctionChunk(
    context: SegmentBuildContext,
    node: FunctionCallNode,
    index: number,
  ): string {
    return createHash('sha1')
      .update(context.sessionId)
      .update(context.groupId)
      .update(node.fn ?? '')
      .update(node.file ?? '')
      .update(String(node.line ?? -1))
      .update(String(node.eventStart))
      .update(String(node.eventEnd))
      .update(String(index))
      .digest('hex');
  }

  private describeFunctionEvent(
    event: TraceSegmentEvent,
    index: number,
  ): string {
    const fn = this.extractEventFn(event) || 'anonymous';
    const file = this.extractEventFile(event) ?? '';
    const line = this.formatLine(this.extractEventLine(event));
    const type = this.toText(event.type);
    const args = this.formatPayload(event.args ?? event.arguments);
    const result = this.formatPayload(event.result ?? event.retVal);
    const duration = this.formatDuration(event.dur ?? event.durationMs);
    const message = this.toShortText(event.message ?? event.msg, 160);
    const descriptor = [
      `  - [${index + 1}]`,
      fn,
      file || line ? `(${[file, line].filter(Boolean).join(':')})` : null,
      type ? `[${type}]` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const extras = [
      message ? `msg="${message}"` : null,
      args ? `args=${args}` : null,
      result ? `result=${result}` : null,
      duration ? `dur=${duration}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return extras ? `${descriptor} ${extras}` : descriptor;
  }

  private toShortText(value: any, maxLength = 160): string {
    const text = this.toText(value);
    if (!text) {
      return '';
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private buildSyntheticNodeId(
    fn: string,
    file: string,
    line: number,
    idx: number,
    counters: Map<string, number>,
  ): string {
    const key = [fn || 'fn', file || 'file', line || 'line'].join('|');
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    return createHash('sha1')
      .update(key)
      .update(String(idx))
      .update(String(count))
      .digest('hex');
  }

  private findNodeInStackById(
    stack: FunctionCallNode[],
    identifier?: string | null,
  ): FunctionCallNode | undefined {
    if (!identifier) {
      return undefined;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].localId === identifier) {
        return stack[i];
      }
    }
    return undefined;
  }

  private detachNodeFromStack(
    stack: FunctionCallNode[],
    node: FunctionCallNode,
  ): void {
    const idx = stack.lastIndexOf(node);
    if (idx >= 0) {
      stack.splice(idx);
    }
  }

  private isEnterEvent(type: string): boolean {
    const normalized = type.toLowerCase();
    return ['enter', 'start', 'call', 'invoke', 'begin'].includes(normalized);
  }

  private isExitEvent(type: string): boolean {
    const normalized = type.toLowerCase();
    return ['exit', 'end', 'finish', 'return', 'stop'].includes(normalized);
  }

  private extractEventIdentifier(event: TraceSegmentEvent): string | undefined {
    const candidates = [
      event?.id,
      event?.callId,
      event?.spanId,
      event?.eventId,
      event?.nodeId,
      event?.scopeId,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) {
        continue;
      }
      const text = this.toText(candidate);
      if (text) {
        return text;
      }
    }
    return undefined;
  }

  private extractFunctionDescriptor(event: TraceSegmentEvent): {
    fn?: string;
    file?: string;
    line?: number;
  } {
    return {
      fn: this.extractEventFn(event),
      file: this.extractEventFile(event),
      line: this.extractEventLine(event),
    };
  }

  private extractEventArgsPreview(
    event: TraceSegmentEvent,
  ): string | undefined {
    if (!event) {
      return undefined;
    }
    const candidate =
      event.args ??
      event.arguments ??
      event.payload?.args ??
      event.meta?.args ??
      event.context?.args;
    const text = this.formatPayload(candidate);
    return text || undefined;
  }

  private extractEventResultPreview(
    event: TraceSegmentEvent,
  ): string | undefined {
    if (!event) {
      return undefined;
    }
    const candidate =
      event.result ??
      event.return ??
      event.retVal ??
      event.response ??
      event.payload?.result;
    const text = this.formatPayload(candidate);
    return text || undefined;
  }

  private extractEventDurationMs(event: TraceSegmentEvent): number | undefined {
    if (!event) {
      return undefined;
    }
    const candidate =
      event.dur ??
      event.duration ??
      event.durationMs ??
      event.elapsed ??
      event.elapsedMs ??
      event.timing;
    const num = Number(candidate);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    return Math.max(0, Math.round(num));
  }

  private extractEventFn(event: TraceSegmentEvent): string | undefined {
    if (!event) {
      return undefined;
    }
    const fn = this.pickTextFromPaths(event, [
      'fn',
      'function',
      'functionName',
      'displayName',
      'name',
      'method',
      'operation',
      'opName',
      'callee',
      'target',
      'meta.fn',
      'meta.function',
      'context.function',
    ]);
    return fn || undefined;
  }

  private extractEventFile(event: TraceSegmentEvent): string | undefined {
    if (!event) {
      return undefined;
    }
    const file = this.pickTextFromPaths(event, [
      'file',
      'filePath',
      'filepath',
      'path',
      'location.file',
      'location.path',
      'loc.file',
      'source.file',
      'source.path',
      'meta.file',
      'frame.file',
      'frame.filename',
      'stack[0].file',
      'stack[0].filename',
      'stack[0].source',
    ]);
    return file ? this.compactFilePath(file) : undefined;
  }

  private extractEventLine(event: TraceSegmentEvent): number | undefined {
    if (!event) {
      return undefined;
    }
    return this.pickNumberFromPaths(event, [
      'line',
      'lineNumber',
      'lineno',
      'location.line',
      'loc.line',
      'source.line',
      'meta.line',
      'frame.line',
      'stack[0].line',
    ]);
  }

  private enrichNodeFromEvent(
    node: FunctionCallNode | undefined,
    event: TraceSegmentEvent,
  ): void {
    if (!node || !event) {
      return;
    }
    const fn = this.extractEventFn(event);
    if (fn && (!node.fn || node.fn === 'anonymous')) {
      node.fn = fn;
    }
    const file = this.extractEventFile(event);
    if (file && !node.file) {
      node.file = file;
    }
    const line = this.extractEventLine(event);
    if (
      typeof line === 'number' &&
      Number.isFinite(line) &&
      (typeof node.line !== 'number' || !Number.isFinite(node.line))
    ) {
      node.line = line;
    }
    const args = this.extractEventArgsPreview(event);
    if (args && !node.argsPreview) {
      node.argsPreview = args;
    }
    const result = this.extractEventResultPreview(event);
    if (result && !node.resultPreview) {
      node.resultPreview = result;
    }
    const duration = this.extractEventDurationMs(event);
    if (typeof duration === 'number') {
      if (
        typeof node.durationMs !== 'number' ||
        !Number.isFinite(node.durationMs) ||
        duration > node.durationMs
      ) {
        node.durationMs = duration;
      }
    }
    this.collectNodeMetadata(node, event);
  }

  private collectNodeMetadata(
    node: FunctionCallNode,
    event: TraceSegmentEvent,
  ): void {
    const pairs: Array<[string, string]> = [];
    const message = this.toShortText(event?.message ?? event?.msg, 240);
    if (message) {
      pairs.push(['message', message]);
    }
    const status = this.toText(
      event?.status ?? event?.statusCode ?? event?.httpStatus,
    );
    if (status) {
      pairs.push(['status', status]);
    }
    const url = this.toText(event?.url ?? event?.path ?? event?.route);
    if (url) {
      pairs.push(['url', url]);
    }
    const collection = this.toText(
      event?.collection ?? event?.table ?? event?.model,
    );
    if (collection) {
      pairs.push(['collection', collection]);
    }
    const operation = this.toText(event?.operation ?? event?.op);
    if (operation) {
      pairs.push(['operation', operation]);
    }
    for (const [key, value] of pairs) {
      this.appendNodeMetadata(node, key, value);
    }
  }

  private appendNodeMetadata(
    node: FunctionCallNode,
    key: string,
    value: string,
  ): void {
    if (!key || !value) {
      return;
    }
    if (!node.metadata) {
      node.metadata = [];
    }
    if (node.metadata.length >= 12) {
      return;
    }
    if (
      node.metadata.some((entry) => entry.key === key && entry.value === value)
    ) {
      return;
    }
    node.metadata.push({ key, value });
  }

  private pickTextFromPaths(
    source: Record<string, any>,
    paths: string[],
  ): string {
    for (const path of paths) {
      const value = this.getValueAtPath(source, path);
      const text = this.toText(value);
      if (text) {
        return text;
      }
    }
    return '';
  }

  private pickNumberFromPaths(
    source: Record<string, any>,
    paths: string[],
  ): number | undefined {
    for (const path of paths) {
      const value = this.getValueAtPath(source, path);
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.floor(num);
      }
    }
    return undefined;
  }

  private getValueAtPath(source: Record<string, any>, path: string): any {
    if (!source || typeof source !== 'object' || !path) {
      return undefined;
    }
    const normalized = path.replace(/\[(\d+)\]/g, '.$1');
    const segments = normalized.split('.');
    let current: any = source;
    for (const segment of segments) {
      if (!segment.length) {
        continue;
      }
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
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
      return text.length > FUNCTION_PAYLOAD_PREVIEW_LIMIT
        ? `${text.slice(0, FUNCTION_PAYLOAD_PREVIEW_LIMIT - 3)}...`
        : text;
    } catch {
      const text = String(value);
      return text.length > FUNCTION_PAYLOAD_PREVIEW_LIMIT
        ? `${text.slice(0, FUNCTION_PAYLOAD_PREVIEW_LIMIT - 3)}...`
        : text;
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
      fn: this.extractEventFn(event) || null,
      file: this.extractEventFile(event) || null,
      line: this.extractEventLine(event) ?? null,
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
    segment: TraceSegmentDescriptor,
  ): Record<string, string | number | boolean> {
    const metadata: Record<string, string | number | boolean> = {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      groupId,
      segmentIndex: segment.segmentIndex,
      batchIndex: payload.batchIndex,
      eventStart: segment.eventStart,
      eventEnd: segment.eventEnd,
      eventCount: segment.eventCount,
    };
    if (payload.requestRid) metadata.requestRid = payload.requestRid;
    if (payload.actionId) metadata.actionId = payload.actionId;
    if (payload.totalBatches != null) {
      metadata.totalBatches = payload.totalBatches;
    }
    if (segment.chunkId) {
      metadata.chunkId = segment.chunkId;
    }
    if (segment.parentChunkId) {
      metadata.parentChunkId = segment.parentChunkId;
    }
    if (segment.chunkKind) {
      metadata.chunkKind = segment.chunkKind;
    }
    if (typeof segment.depth === 'number' && Number.isFinite(segment.depth)) {
      metadata.depth = segment.depth;
    }
    if (segment.functionName) {
      metadata.functionName = segment.functionName;
    }
    if (segment.filePath) {
      metadata.filePath = segment.filePath;
    }
    if (
      typeof segment.lineNumber === 'number' &&
      Number.isFinite(segment.lineNumber)
    ) {
      metadata.lineNumber = segment.lineNumber;
    }
    return metadata;
  }

  private async upsertVectorRecord(
    record: PineconeVectorRecord,
  ): Promise<void> {
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

  private async ensurePineconeNamespaceClient(): Promise<Index<
    Record<string, string | number | boolean>
  > | null> {
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

  private async ensurePineconeIndex(): Promise<Index<
    Record<string, string | number | boolean>
  > | null> {
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
        controllerHost
          ? { apiKey, controllerHostUrl: controllerHost }
          : { apiKey },
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
