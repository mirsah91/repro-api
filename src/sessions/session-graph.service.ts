import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VoyageAIClient } from 'voyageai';
import OpenAI from 'openai';
import { encode } from '@toon-format/toon';
import { Session } from './schemas/session.schema';
import { Action } from './schemas/action.schema';
import { RequestEvt } from './schemas/request.schema';
import { DbChange } from './schemas/db-change.schema';
import { TraceSummary } from './schemas/trace-summary.schema';
import { TraceEvt } from './schemas/trace.schema';
import { SessionGraphNode } from './schemas/session-graph-node.schema';
import { SessionGraphEdge } from './schemas/session-graph-edge.schema';
import { SessionFact } from './schemas/session-fact.schema';
import { TenantContext } from '../common/tenant/tenant-context';
import {
  hydrateChangeDoc,
  hydrateRequestDoc,
} from './utils/session-data-crypto';

const CAPABILITY_LABELS = [
  'messaging',
  'notification',
  'email',
  'queue',
  'pubsub',
  'db',
  'cache',
  'http-client',
  'auth',
  'logging',
  'metrics',
  'search',
  'payment',
  'storage',
];

const FACT_TEXT_LIMIT = 1600;
const FACT_CANDIDATE_LIMIT = 400;
const FACT_RESULT_LIMIT = 40;
const GRAPH_NEIGHBOR_LIMIT = 120;
const EMBEDDING_INPUT_LIMIT = 1200;
const EMBEDDING_BATCH_SIZE = 60;
const EMBEDDING_MAX_FACTS = 1200;
const EMBEDDING_TIMEOUT_MS = 20000;
const ANSWER_PRIMARY_HIT_LIMIT = 6;
const ANSWER_NEIGHBOR_LIMIT = 6;
const ANSWER_NODE_LIMIT = 10;
const ANSWER_COLLECTION_LIMIT = 6;
const ANSWER_STRING_LIMIT = 600;
const ANSWER_LIST_LIMIT = 8;

type CoreCollectionName = 'actions' | 'requests' | 'traces' | 'changes';
type CoreCollections = Partial<Record<CoreCollectionName, any[]>>;
type NodeSelection = {
  nodeId: string;
  nodeType: string;
  collection?: CoreCollectionName;
  sourceId?: string;
};

export type ReproAiAnswer = {
  summary: string;
  details: string[];
  evidence: Array<{
    nodeId: string;
    nodeType: string;
    title?: string;
    why?: string;
    score?: number;
    capabilityTags?: string[];
  }>;
  uncertainties: string[];
  suggestedFollowUps: string[];
};

type GraphSearchHit = {
  fact: SessionFact;
  score: number;
  node?: SessionGraphNode;
};

@Injectable()
export class SessionGraphService {
  private readonly logger = new Logger(SessionGraphService.name);
  private voyage?: VoyageAIClient;
  private openai?: OpenAI;
  private capabilityVectors?:
    | Array<{ tag: string; embedding: number[] }>
    | undefined;

  constructor(
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(Action.name) private readonly actions: Model<Action>,
    @InjectModel(RequestEvt.name)
    private readonly requests: Model<RequestEvt>,
    @InjectModel(DbChange.name) private readonly changes: Model<DbChange>,
    @InjectModel(TraceSummary.name)
    private readonly traceSummaries: Model<TraceSummary>,
    @InjectModel(TraceEvt.name) private readonly traces: Model<TraceEvt>,
    @InjectModel(SessionGraphNode.name)
    private readonly graphNodes: Model<SessionGraphNode>,
    @InjectModel(SessionGraphEdge.name)
    private readonly graphEdges: Model<SessionGraphEdge>,
    @InjectModel(SessionFact.name)
    private readonly graphFacts: Model<SessionFact>,
    private readonly tenant: TenantContext,
    private readonly config: ConfigService,
  ) {}

  async rebuildSessionGraph(
    sessionId: string,
    opts?: { appId?: string; skipEmbeddings?: boolean; limitPerType?: number },
  ): Promise<{
    sessionId: string;
    tenantId: string;
    counts: { nodes: number; edges: number; facts: number };
  }> {
    this.logger.log(
      `Rebuilding session graph for ${sessionId} (skipEmbeddings=${Boolean(opts?.skipEmbeddings)})`,
    );
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

    const tenantId = sessionDoc.tenantId ?? this.tenant.tenantId;
    const limit = Math.max(10, Math.min(opts?.limitPerType ?? 600, 2000));

    const [actions, requests, traces, dbChanges] = await Promise.all([
      this.actions
        .find(this.tenantFilter({ sessionId }))
        .limit(limit)
        .lean()
        .exec(),
      this.requests
        .find(this.tenantFilter({ sessionId }))
        .limit(limit)
        .lean()
        .exec(),
      this.traceSummaries
        .find(this.tenantFilter({ sessionId }))
        .limit(limit * 3)
        .lean()
        .exec(),
      this.changes
        .find(this.tenantFilter({ sessionId }))
        .limit(limit)
        .lean()
        .exec(),
    ]);

    const nodeMap = new Map<string, SessionGraphNode>();
    const factList: Array<SessionFact & { embedding?: number[] }> = [];
    const seenFactIds = new Set<string>();
    const edges: SessionGraphEdge[] = [];

    actions.forEach((action, index) => {
      const nodeId = `action:${action.actionId ?? index + 1}`;
      const capabilityTags = this.deriveCapabilityTags([
        action.label,
        action.ui ? JSON.stringify(action.ui) : undefined,
      ]);
      const rawText = this.describeAction(action);
      nodeMap.set(nodeId, {
        _id: nodeId,
        tenantId,
        sessionId,
        type: 'action',
        sourceCollection: 'actions',
        sourceId: action.actionId ?? String(action._id ?? nodeId),
        title: action.label ?? 'action',
        rawText,
        structured: {
          actionId: action.actionId,
          label: action.label,
          tStart: action.tStart,
          tEnd: action.tEnd,
        },
        capabilityTags,
        scoreSignals: { error: Boolean(action.error) },
      });
      this.pushFact(factList, seenFactIds, {
        _id: `fact:${nodeId}`,
        tenantId,
        sessionId,
        nodeId,
        nodeType: 'action',
        text: this.truncate(rawText, FACT_TEXT_LIMIT),
        structured: { actionId: action.actionId, label: action.label },
        capabilityTags: [...capabilityTags],
        scoreSignals: { isError: Boolean(action.error) },
      });
    });

    const requestsByAction = new Map<string, string[]>();
    requests.forEach((request, index) => {
      const nodeId = `request:${request.rid ?? index + 1}`;
      const capabilityTags = this.deriveCapabilityTags([
        request.url,
        request.method,
        request.entryPoint?.fn ?? undefined,
      ]);
      const rawText = this.describeRequest(request);
      nodeMap.set(nodeId, {
        _id: nodeId,
        tenantId,
        sessionId,
        type: 'request',
        sourceCollection: 'requests',
        sourceId: request.rid ?? String(request._id ?? nodeId),
        title: `${(request.method ?? 'GET').toUpperCase()} ${
          request.url ?? '/'
        }`,
        rawText,
        structured: {
          rid: request.rid,
          method: request.method,
          url: request.url,
          status: request.status,
          entryPoint: request.entryPoint,
        },
        capabilityTags,
        scoreSignals: { isError: this.isErrorStatus(request.status) },
      });
      this.pushFact(factList, seenFactIds, {
        _id: `fact:${nodeId}`,
        tenantId,
        sessionId,
        nodeId,
        nodeType: 'request',
        text: this.truncate(rawText, FACT_TEXT_LIMIT),
        structured: {
          rid: request.rid,
          method: request.method,
          url: request.url,
          status: request.status,
        },
        capabilityTags: [...capabilityTags],
        scoreSignals: {
          isError: this.isErrorStatus(request.status),
        },
      });

      const actionId = request.actionId ?? '';
      if (actionId) {
        const list = requestsByAction.get(actionId) ?? [];
        list.push(nodeId);
        requestsByAction.set(actionId, list);
        edges.push(
          this.buildEdge(
            tenantId,
            sessionId,
            `action:${actionId}`,
            nodeId,
            'initiates',
          ),
        );
      }
    });

    traces.forEach((trace, index) => {
      const nodeId = `trace:${trace.chunkId ?? trace.segmentIndex ?? index}`;
      const capabilityTags = this.deriveCapabilityTags([
        trace.functionName ?? undefined,
        trace.filePath ?? undefined,
        trace.summary ?? undefined,
      ]);
      const rawText = this.describeTraceSummary(trace);
      nodeMap.set(nodeId, {
        _id: nodeId,
        tenantId,
        sessionId,
        type: 'trace_span',
        sourceCollection: 'trace_summaries',
        sourceId: trace.segmentHash ?? nodeId,
        title:
          trace.functionName ??
          trace.filePath ??
          `trace segment ${trace.segmentIndex}`,
        rawText,
        structured: {
          chunkId: trace.chunkId,
          functionName: trace.functionName,
          filePath: trace.filePath,
          lineNumber: trace.lineNumber,
          traceId: trace.groupId,
          requestRid: trace.requestRid,
        },
        capabilityTags,
        scoreSignals: { isError: false },
      });
      this.pushFact(factList, seenFactIds, {
        _id: `fact:${nodeId}`,
        tenantId,
        sessionId,
        nodeId,
        nodeType: 'trace_span',
        text: this.truncate(rawText, FACT_TEXT_LIMIT),
        structured: {
          chunkId: trace.chunkId,
          functionName: trace.functionName,
          filePath: trace.filePath,
          lineNumber: trace.lineNumber,
          traceId: trace.groupId,
          requestRid: trace.requestRid,
        },
        capabilityTags: [...capabilityTags],
        scoreSignals: {},
      });

      if (trace.requestRid) {
        edges.push(
          this.buildEdge(
            tenantId,
            sessionId,
            `request:${trace.requestRid}`,
            nodeId,
            'handled_by',
          ),
        );
      }
      if (trace.parentChunkId) {
        edges.push(
          this.buildEdge(
            tenantId,
            sessionId,
            `trace:${trace.parentChunkId}`,
            nodeId,
            'child',
          ),
        );
      }
    });

    dbChanges.forEach((change, index) => {
      const nodeId = `change:${change._id ?? index + 1}`;
      const capabilityTags = this.deriveCapabilityTags([
        change.collection,
        change.op,
      ]);
      const rawText = this.describeChange(change);
      nodeMap.set(nodeId, {
        _id: nodeId,
        tenantId,
        sessionId,
        type: 'change',
        sourceCollection: 'changes',
        sourceId: String(change._id ?? nodeId),
        title: `${change.op ?? 'operation'} on ${change.collection ?? 'N/A'}`,
        rawText,
        structured: {
          collection: change.collection,
          op: change.op,
          pk: change.pk,
          resultMeta: change.resultMeta,
        },
        capabilityTags,
        scoreSignals: {
          isChangeRelated: true,
          isError: Boolean(change.error),
        },
      });
      this.pushFact(factList, seenFactIds, {
        _id: `fact:${nodeId}`,
        tenantId,
        sessionId,
        nodeId,
        nodeType: 'change',
        text: this.truncate(rawText, FACT_TEXT_LIMIT),
        structured: {
          collection: change.collection,
          op: change.op,
          pk: change.pk,
          resultMeta: change.resultMeta,
        },
        capabilityTags: [...capabilityTags],
        scoreSignals: {
          isChangeRelated: true,
          isError: Boolean(change.error),
        },
      });

      const actionId = change.actionId ?? '';
      if (actionId) {
        edges.push(
          this.buildEdge(
            tenantId,
            sessionId,
            `action:${actionId}`,
            nodeId,
            'touches',
          ),
        );

        const relatedRequests = requestsByAction.get(actionId) ?? [];
        relatedRequests.forEach((rid) => {
          edges.push(
            this.buildEdge(
              tenantId,
              sessionId,
              rid,
              nodeId,
              'triggers_change',
            ),
          );
        });
      }
    });

    const filters = this.tenantFilter({ sessionId });
    await Promise.all([
      this.graphNodes.deleteMany(filters),
      this.graphEdges.deleteMany(filters),
      this.graphFacts.deleteMany(filters),
    ]);

    const nodes = Array.from(nodeMap.values());
    const nodeIds = new Set(nodes.map((node) => node._id));
    const dedupedEdges = this.dedupEdges(edges).filter(
      (edge) =>
        nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId ?? ''),
    );

    if (nodes.length) {
      await this.graphNodes.deleteMany({
        _id: { $in: nodes.map((node) => node._id) },
      });
    }
    if (dedupedEdges.length) {
      await this.graphEdges.deleteMany({
        _id: { $in: dedupedEdges.map((edge) => edge._id) },
      });
    }
    if (factList.length) {
      await this.graphFacts.deleteMany({
        _id: { $in: factList.map((fact) => fact._id) },
      });
    }

    const embeddingTargets = factList.slice(0, EMBEDDING_MAX_FACTS);
    if (!opts?.skipEmbeddings && embeddingTargets.length) {
      this.logger.log(
        `Embedding ${embeddingTargets.length} facts (truncated from ${factList.length}) for session ${sessionId}`,
      );
      await this.ensureCapabilityEmbeddings();
      const embeddings = await this.embedTexts(
        embeddingTargets.map((fact) =>
          this.normalizeEmbeddingText(fact.text),
        ),
      );

      if (embeddings.length === embeddingTargets.length) {
        embeddingTargets.forEach((fact, idx) => {
          fact.embedding = embeddings[idx];
          const derived = this.tagsFromEmbedding(embeddings[idx]);
          fact.capabilityTags = this.mergeTags(
            fact.capabilityTags,
            derived,
            this.deriveCapabilityTags([JSON.stringify(fact.structured ?? {})]),
          );
          const node = nodeMap.get(fact.nodeId);
          if (node) {
            node.capabilityTags = this.mergeTags(
              node.capabilityTags ?? [],
              fact.capabilityTags,
            );
          }
        });
      }
    }

    if (nodes.length) {
      await this.graphNodes
        .bulkWrite(
          nodes.map((node) => ({
            replaceOne: {
              filter: { _id: node._id },
              replacement: node,
              upsert: true,
            },
          })),
          { ordered: false },
        )
        .catch((err) =>
          this.logger.warn(
            `Failed inserting graph nodes for session ${sessionId}: ${
              err?.message ?? err
            }`,
          ),
        );
    }
    if (dedupedEdges.length) {
      await this.graphEdges
        .bulkWrite(
          dedupedEdges.map((edge) => ({
            replaceOne: {
              filter: { _id: edge._id },
              replacement: edge,
              upsert: true,
            },
          })),
          { ordered: false },
        )
        .catch((err) =>
          this.logger.warn(
            `Failed inserting graph edges for session ${sessionId}: ${
              err?.message ?? err
            }`,
          ),
        );
    }
    if (factList.length) {
      await this.graphFacts
        .bulkWrite(
          factList.map((fact) => ({
            replaceOne: {
              filter: { _id: fact._id },
              replacement: fact,
              upsert: true,
            },
          })),
          { ordered: false },
        )
        .catch((err) =>
          this.logger.warn(
            `Failed inserting session facts for session ${sessionId}: ${
              err?.message ?? err
            }`,
          ),
        );
    }

    return {
      sessionId,
      tenantId,
      counts: {
        nodes: nodes.length,
        edges: dedupedEdges.length,
        facts: factList.length,
      },
    };
  }

  async searchFacts(params: {
    sessionId: string;
    question: string;
    nodeTypes?: string[];
    capabilityTags?: string[];
    limit?: number;
  }): Promise<{ hits: GraphSearchHit[]; questionCapabilities: string[] }> {
    const { sessionId } = params;
    const filters: Record<string, any> = this.tenantFilter({ sessionId });
    if (params.nodeTypes?.length) {
      filters.nodeType = { $in: params.nodeTypes };
    }
    if (params.capabilityTags?.length) {
      filters.capabilityTags = { $in: params.capabilityTags };
    }

    const facts = await this.graphFacts
      .find(filters)
      .limit(FACT_CANDIDATE_LIMIT)
      .lean()
      .exec();

    if (!facts.length) {
      return { hits: [], questionCapabilities: [] };
    }

    const questionCapabilities = this.mergeTags(
      params.capabilityTags ?? [],
      this.deriveCapabilityTags([params.question]),
    );
    const questionEmbedding = await this.embedQuestion(params.question);
    const hits = facts
      .map((fact) => {
        const capBoost = this.computeTagBoost(
          fact.capabilityTags ?? [],
          questionCapabilities,
        );
        const similarity = questionEmbedding?.length
          ? this.cosineSimilarity(questionEmbedding, fact.embedding)
          : this.lexicalScore(params.question, fact.text);
        const scoreSignals = fact.scoreSignals ?? {};
        const errorBoost = scoreSignals.isError ? 0.05 : 0;
        const changeBoost = scoreSignals.isChangeRelated ? 0.05 : 0;
        const score = (similarity ?? 0) + capBoost + errorBoost + changeBoost;
        return { fact, score };
      })
      .filter((entry) => Number.isFinite(entry.score));

    hits.sort((a, b) => b.score - a.score);
    const limited = hits.slice(
      0,
      Math.max(5, Math.min(params.limit ?? FACT_RESULT_LIMIT, FACT_RESULT_LIMIT)),
    );

    return { hits: limited, questionCapabilities };
  }

  async answerQuestion(params: {
    sessionId: string;
    question: string;
    appId?: string;
    nodeTypes?: string[];
    capabilityTags?: string[];
    limit?: number;
    rebuildIndex?: boolean;
  }): Promise<{
    sessionId: string;
    question: string;
    answer: ReproAiAnswer;
    hits: Array<GraphSearchHit>;
    graph: { nodes: SessionGraphNode[]; edges: SessionGraphEdge[] };
  }> {
    if (!params.sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }
    if (!params.question?.trim()) {
      throw new BadRequestException('question is required');
    }

    const sessionDoc = await this.sessions
      .findOne(
        this.tenantFilter({
          _id: params.sessionId,
          ...(params.appId ? { appId: params.appId } : {}),
        }),
      )
      .lean()
      .exec();

    if (!sessionDoc) {
      throw new NotFoundException('Session not found');
    }

    const existingFacts = await this.graphFacts
      .countDocuments(this.tenantFilter({ sessionId: params.sessionId }))
      .exec();
    if (!existingFacts || params.rebuildIndex) {
      await this.rebuildSessionGraph(params.sessionId, {
        appId: params.appId,
      });
    }

    const searchResult = await this.searchFacts(params);
    const hits = searchResult.hits;
    const nodeIds = hits.map((hit) => hit.fact.nodeId);
    const graph = await this.expandGraph(params.sessionId, nodeIds, 2);
    const nodeMap = new Map(
      graph.nodes.map((node) => [node._id, node] as const),
    );
    hits.forEach((hit) => {
      hit.node = nodeMap.get(hit.fact.nodeId);
    });

    const answer = await this.generateAnswer({
      session: sessionDoc,
      question: params.question,
      hits,
      graph,
      questionCapabilities: searchResult.questionCapabilities,
    });

    return {
      sessionId: params.sessionId,
      question: params.question,
      answer,
      hits,
      graph,
    };
  }

  async expandGraph(
    sessionId: string,
    seedNodeIds: string[],
    maxDepth = 1,
  ): Promise<{ nodes: SessionGraphNode[]; edges: SessionGraphEdge[] }> {
    if (!seedNodeIds.length) {
      return { nodes: [], edges: [] };
    }
    const filters = this.tenantFilter({ sessionId });
    const edges = await this.graphEdges
      .find({
        ...filters,
        $or: [
          { fromNodeId: { $in: seedNodeIds } },
          { toNodeId: { $in: seedNodeIds } },
        ],
      })
      .limit(GRAPH_NEIGHBOR_LIMIT)
      .lean()
      .exec();
    const nodeIds = new Set<string>(seedNodeIds);
    edges.forEach((edge) => {
      nodeIds.add(edge.fromNodeId);
      if (edge.toNodeId) {
        nodeIds.add(edge.toNodeId);
      }
    });

    if (maxDepth > 1) {
      const secondaryEdges = await this.graphEdges
        .find({
          ...filters,
          $or: [
            { fromNodeId: { $in: Array.from(nodeIds) } },
            { toNodeId: { $in: Array.from(nodeIds) } },
          ],
        })
        .limit(GRAPH_NEIGHBOR_LIMIT)
        .lean()
        .exec();
      secondaryEdges.forEach((edge) => {
        edges.push(edge);
        nodeIds.add(edge.fromNodeId);
        if (edge.toNodeId) {
          nodeIds.add(edge.toNodeId);
        }
      });
    }

    const nodes = await this.graphNodes
      .find({ ...filters, _id: { $in: Array.from(nodeIds) } })
      .lean()
      .exec();
    return { nodes, edges: this.dedupEdges(edges) };
  }

  private describeAction(action: Action): string {
    return [
      `Action ${action.actionId ?? 'unknown'}: ${action.label ?? 'action'}`,
      action.hasReq ? 'Triggers request(s)' : null,
      action.hasDb ? 'Touches DB' : null,
      action.error ? 'Error=true' : null,
      action.tStart ? `start=${action.tStart}` : null,
      action.tEnd ? `end=${action.tEnd}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private describeRequest(request: RequestEvt): string {
    const method = (request.method ?? 'GET').toUpperCase();
    const entryPoint = request.entryPoint?.fn
      ? `entry:${request.entryPoint.fn} (${request.entryPoint.file ?? ''}:${
          request.entryPoint.line ?? ''
        })`
      : null;
    return [
      `${method} ${request.url ?? '/'}`,
      typeof request.status === 'number' ? `status=${request.status}` : null,
      request.actionId ? `action=${request.actionId}` : null,
      entryPoint,
      request.key ? `key=${request.key}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private describeTraceSummary(summary: TraceSummary): string {
    return [
      summary.functionName ?? summary.filePath ?? 'trace',
      summary.groupId ? `traceId=${summary.groupId}` : null,
      summary.requestRid ? `request=${summary.requestRid}` : null,
      typeof summary.segmentIndex === 'number'
        ? `segment=${summary.segmentIndex}`
        : null,
      summary.summary ?? '',
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private describeChange(change: DbChange): string {
    const parts = [
      `${change.op ?? 'operation'} ${change.collection ?? 'collection'}`,
      change.actionId ? `action=${change.actionId}` : null,
      change.pk ? `pk=${JSON.stringify(change.pk)}` : null,
    ];
    if (change.query?.filter) {
      parts.push(`filter=${JSON.stringify(change.query.filter)}`);
    }
    if (change.error?.message) {
      parts.push(`error=${change.error.message}`);
    }
    return parts.filter(Boolean).join(' | ');
  }

  private buildEdge(
    tenantId: string,
    sessionId: string,
    fromNodeId: string,
    toNodeId: string,
    relation: string,
  ): SessionGraphEdge {
    const edgeId = `edge:${fromNodeId}->${toNodeId}:${relation}`;
    return {
      _id: edgeId,
      tenantId,
      sessionId,
      fromNodeId,
      toNodeId,
      relation,
    };
  }

  private dedupEdges(edges: SessionGraphEdge[]): SessionGraphEdge[] {
    const seen = new Set<string>();
    const result: SessionGraphEdge[] = [];
    edges.forEach((edge) => {
      const key = `${edge.fromNodeId}->${edge.toNodeId}:${edge.relation}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      result.push(edge);
    });
    return result;
  }

  private deriveCapabilityTags(inputs: Array<string | undefined>): string[] {
    const text = inputs
      .filter((val) => typeof val === 'string' && val.length)
      .join(' ')
      .toLowerCase();
    const tags = new Set<string>();
    const add = (tag: string) => tags.add(tag);

    if (/[^\w]?kafka|queue|pubsub|mq|rabbit|sns|sqs|topic/.test(text)) {
      add('messaging');
      add('queue');
      add('pubsub');
    }
    if (/email|smtp|sendgrid|mailgun|mailer|inbox/.test(text)) {
      add('email');
      add('notification');
    }
    if (/notif|notify|alert|webhook/.test(text)) {
      add('notification');
    }
    if (/auth|login|jwt|token|oauth/.test(text)) {
      add('auth');
    }
    if (/cache|redis|memcache/.test(text)) {
      add('cache');
    }
    if (/db|database|collection|mongo|sql|postgres|mysql/.test(text)) {
      add('db');
    }
    if (/http|request|endpoint|rest|grpc|api\b/.test(text)) {
      add('http-client');
    }
    if (/metric|prometheus|statsd|telemetry/.test(text)) {
      add('metrics');
    }
    if (/log|trace|logger/.test(text)) {
      add('logging');
    }
    if (/payment|stripe|paypal|charge|checkout/.test(text)) {
      add('payment');
    }
    if (/search|index|query\b/.test(text)) {
      add('search');
    }
    if (/storage|bucket|s3|blob/.test(text)) {
      add('storage');
    }
    return Array.from(tags);
  }

  private mergeTags(...lists: Array<string[] | undefined>): string[] {
    const set = new Set<string>();
    lists.forEach((list) => {
      list?.forEach((tag) => {
        if (typeof tag === 'string' && tag.trim()) {
          set.add(tag.trim().toLowerCase());
        }
      });
    });
    return Array.from(set);
  }

  private async ensureCapabilityEmbeddings(): Promise<void> {
    if (this.capabilityVectors?.length) {
      return;
    }
    const embeddings = await this.embedTexts(CAPABILITY_LABELS);
    if (embeddings.length !== CAPABILITY_LABELS.length) {
      this.capabilityVectors = [];
      return;
    }
    this.capabilityVectors = CAPABILITY_LABELS.map((tag, idx) => ({
      tag,
      embedding: embeddings[idx],
    }));
  }

  private tagsFromEmbedding(vec?: number[]): string[] {
    if (!vec?.length || !this.capabilityVectors?.length) {
      return [];
    }
    const tags: string[] = [];
    this.capabilityVectors.forEach((entry) => {
      const score = this.cosineSimilarity(vec, entry.embedding);
      if (score >= 0.25) {
        tags.push(entry.tag);
      }
    });
    return tags;
  }

  private computeTagBoost(
    factTags: string[],
    questionTags: string[],
  ): number {
    if (!factTags?.length || !questionTags?.length) {
      return 0;
    }
    const factSet = new Set(factTags.map((tag) => tag.toLowerCase()));
    const matches = questionTags.filter((tag) =>
      factSet.has(tag.toLowerCase()),
    );
    return matches.length ? Math.min(0.12, matches.length * 0.04) : 0;
  }

  private async generateAnswer(payload: {
    session: Session;
    question: string;
    hits: GraphSearchHit[];
    graph: { nodes: SessionGraphNode[]; edges: SessionGraphEdge[] };
    questionCapabilities: string[];
  }): Promise<ReproAiAnswer> {
    const systemPrompt = [
      'You are Repro AI, an expert assistant for a SINGLE debugging session.',
      '',
      'CONTEXT',
      '- You receive TOON-encoded documents from the core collections only: actions, requests, traces, and changes.',
      '- Each document may include a nodeId that maps back to the internal session graph—use that nodeId in evidence when present.',
      '- Do not assume any other nodes or relationships beyond what appears in the provided documents.',
      '- When helpful, link related documents via shared identifiers (actionId ↔ requests/changes, requestRid ↔ traces, entryPoint.fn/file/line ↔ traces).',
      '',
      'GENERAL BEHAVIOR',
      '- Use only the provided documents to answer.',
      '- Prefer precise, concrete answers rooted in request payloads, trace arguments/returns, DB changes, and action metadata.',
      '- If the question refers to a “value”, “payload”, “body”, “argument”, “JSON”, “config”, “key”, or “secret”, treat this as a DATA LOOKUP task and quote the exact value(s) from the documents.',
      '- NEVER invent JSON payloads or specific scalar values (IDs, keys, amounts) that are not present in the documents.',
      '- You may truncate large JSON with "…" in non-critical parts, but any keys/values you show must exactly match the source.',
      '',
      'HANDLING UNCERTAINTY',
      '- Never respond with a bare “no context” or “I don’t know”.',
      '- If you cannot find an exact match, explain what you checked in the provided documents and propose exactly one clarifying follow-up question.',
      '',
      'OUTPUT FORMAT (STRICT)',
      '- You MUST respond with a SINGLE top-level JSON object.',
      '- Do NOT wrap the JSON in code fences.',
      '- Do NOT include any text before or after the JSON.',
      '- The JSON MUST have EXACTLY these keys at the top level:',
      '  - summary            (string)',
      '  - details            (array of strings)',
      '  - evidence           (array of objects with keys: nodeId (string), nodeType (string), why (string))',
      '  - uncertainties      (array of strings)',
      '  - suggestedFollowUps (array of strings)',
      '- Do NOT add extra top-level keys.',
      '- If a field has nothing to say, use an empty array [] or an empty string "" as appropriate.',
      '- The JSON MUST be valid and parseable:',
      '  - Use double quotes for all keys and string values.',
      '  - No trailing commas.',
      '  - No comments.',
      '',
      'FIELD SEMANTICS',
      '- "summary":',
      '  - A 1–3 sentence high-level answer to the user’s question.',
      '  - If you are uncertain, state that explicitly here.',
      '- "details":',
      '  - A concise list of more granular explanations, steps, or observations (max ~8 items).',
      '  - Include JSON snippets only when necessary; keep them short (≤ 400 chars) and inline if possible.',
      '  - Do NOT use code fences or triple backticks anywhere in the response.',
      '- "evidence":',
      '  - Each element describes one concrete piece of supporting data from the provided documents.',
      '  - "nodeId": use the document nodeId when available; otherwise use a stable identifier from the document (rid, actionId, trace id, change id).',
      '  - "nodeType": a short type label (e.g. "trace_span", "request", "change", "action").',
      '  - "why": a short explanation of how this item supports your answer.',
      '- "uncertainties":',
      '  - Explicitly list what you are unsure about (e.g. “Not sure if this API key is for production or staging.”).',
      '- "suggestedFollowUps":',
      '  - 0–3 concrete follow-up questions the user could answer to help you refine or validate your answer.',
      '  - If you already gave a precise answer and have no meaningful follow-up, you may return an empty array.',
      '',
      'CONSISTENCY REQUIREMENTS',
      '- ALWAYS follow the JSON schema above, for EVERY answer, regardless of the question.',
      '- Even if the user asks for “just the JSON” or “just the node id”, still respond with the full JSON object in the required format.',
      '- Never change the key names, their types, or the top-level structure.',
    ].join('\n');

    const factPayload = payload.hits.slice(0, FACT_RESULT_LIMIT).map((hit) => ({
      nodeId: hit.fact.nodeId,
      nodeType: hit.fact.nodeType,
      title: hit.node?.title,
      capabilityTags: hit.fact.capabilityTags,
      score: Number(hit.score?.toFixed(4)),
      text: this.truncate(hit.fact.text, 500),
      structured: hit.fact.structured,
    }));

    const context = await this.buildAnswerCollections({
      sessionId: payload.session._id,
      hits: payload.hits,
      graph: payload.graph,
    });
    const toonData = this.collectionsToToon(context.collections);
    const header = {
      sessionId: payload.session._id,
      question: payload.question,
      targetCapabilities: payload.questionCapabilities,
      dataFormat: 'TOON',
      resultCounts: this.countCollections(context.collections),
    };
    const userContent = [
      JSON.stringify(header, null, 2),
      toonData
        ? `TOON:\n${toonData}`
        : 'No matching actions, requests, traces, or changes were retrieved for this query.',
    ].join('\n');

    console.log('userContent ===>', userContent)

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    try {
      const model =
        this.config.get<string>('OPENAI_MODEL')?.trim() ?? 'gpt-4o-mini';
      const client = this.ensureOpenAI();
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages,
        max_tokens: 1100,
      });
      // const completion = {} as any
      const raw = completion.choices?.[0]?.message?.content?.trim();

      console.log('raw ---->', raw)
      const parsedFromSdk =
        (completion as any)?.choices?.[0]?.message?.parsed ??
        (completion as any)?.choices?.[0]?.message?.content?.parsed;
      const parsed =
        (parsedFromSdk as ReproAiAnswer | undefined) ??
        this.parseAnswerContent(raw);
      if (parsed) {
        return this.normalizeAnswer(parsed, factPayload);
      }
      this.logger.warn('LLM returned non-JSON answer; using fallback.');
    } catch (err: any) {
      this.logger.warn(
        `LLM answer generation failed: ${err?.message ?? err}`,
      );
    }

    return this.buildFallbackAnswer(payload.question, factPayload);
  }

  private async buildAnswerCollections(payload: {
    sessionId: string;
    hits: GraphSearchHit[];
    graph: { nodes: SessionGraphNode[]; edges: SessionGraphEdge[] };
  }): Promise<{ collections: CoreCollections; selection: NodeSelection[] }> {
    const nodeMap = new Map<string, SessionGraphNode>(
      payload.graph.nodes.map((node) => [node._id, node] as const),
    );
    const selection: NodeSelection[] = [];
    if (!nodeMap.size) {
      return { collections: {}, selection };
    }

    const candidateIds: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (nodeId?: string | null): boolean => {
      if (!nodeId || !nodeMap.has(nodeId) || seen.has(nodeId)) {
        return false;
      }
      if (seen.size >= ANSWER_NODE_LIMIT) {
        return false;
      }
      seen.add(nodeId);
      candidateIds.push(nodeId);
      return true;
    };

    const seedHits = payload.hits.slice(0, ANSWER_PRIMARY_HIT_LIMIT);
    seedHits.forEach((hit) => addCandidate(hit.fact.nodeId));

    let neighborBudget = ANSWER_NEIGHBOR_LIMIT;
    if (neighborBudget > 0 && payload.graph.edges?.length) {
      const neighborSeen = new Set<string>();
      const neighborPriority = (nodeId: string): number => {
        const nodeType = nodeMap.get(nodeId)?.type;
        switch (nodeType) {
          case 'request':
            return 0;
          case 'change':
            return 1;
          case 'action':
            return 2;
          case 'trace_span':
            return 3;
          default:
            return 4;
        }
      };
      const candidates: Array<{ nodeId: string; priority: number }> = [];
      const pushNeighbor = (nodeId?: string | null) => {
        if (!nodeId || seen.has(nodeId) || neighborSeen.has(nodeId)) {
          return;
        }
        const node = nodeMap.get(nodeId);
        if (!node) {
          return;
        }
        neighborSeen.add(nodeId);
        candidates.push({ nodeId, priority: neighborPriority(nodeId) });
      };

      payload.graph.edges.forEach((edge) => {
        if (seen.has(edge.fromNodeId)) {
          pushNeighbor(edge.toNodeId);
        }
        if (edge.toNodeId && seen.has(edge.toNodeId)) {
          pushNeighbor(edge.fromNodeId);
        }
      });

      candidates.sort((a, b) => a.priority - b.priority);
      for (const candidate of candidates) {
        if (!neighborBudget) {
          break;
        }
        if (addCandidate(candidate.nodeId)) {
          neighborBudget -= 1;
        }
      }
    }

    const nodeIds = candidateIds.slice(0, ANSWER_NODE_LIMIT);
    const selectedNodes = nodeIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is SessionGraphNode => Boolean(node));

    const actionRefs = new Map<string, string>();
    const requestRefs = new Map<string, string>();
    const changeRefs = new Map<string, string>();
    const traceRequestRefs = new Map<string, string>();

    selectedNodes.forEach((node) => {
      const ref = this.extractCoreRef(node);
      if (!ref) {
        return;
      }
      selection.push({
        nodeId: node._id,
        nodeType: node.type,
        collection: ref.collection,
        sourceId: ref.sourceId,
      });
      if (ref.collection === 'actions' && ref.key) {
        actionRefs.set(ref.key, node._id);
      } else if (ref.collection === 'requests' && ref.key) {
        requestRefs.set(ref.key, node._id);
      } else if (ref.collection === 'changes' && ref.key) {
        changeRefs.set(ref.key, node._id);
      } else if (ref.collection === 'traces' && ref.requestRid) {
        traceRequestRefs.set(ref.requestRid, node._id);
      }
    });

    const collections: CoreCollections = {};
    collections.actions = await this.loadActionsForIds(
      payload.sessionId,
      Array.from(actionRefs.keys()),
      actionRefs,
    );
    const requestIds = new Set<string>(requestRefs.keys());
    traceRequestRefs.forEach((_nodeId, rid) => {
      if (typeof rid === 'string') {
        requestIds.add(rid);
      }
    });
    collections.requests = await this.loadRequestsForIds(
      payload.sessionId,
      Array.from(requestIds),
      requestRefs,
    );
    collections.changes = await this.loadChangesForIds(
      payload.sessionId,
      Array.from(changeRefs.keys()),
      changeRefs,
    );
    collections.traces = await this.loadTracesForIds(
      payload.sessionId,
      Array.from(traceRequestRefs.keys()),
      traceRequestRefs,
    );

    return { collections, selection };
  }

  private async loadActionsForIds(
    sessionId: string,
    actionIds: string[],
    nodeLookup: Map<string, string>,
  ): Promise<any[]> {
    const limited = actionIds.slice(0, ANSWER_COLLECTION_LIMIT);
    if (!limited.length) {
      return [];
    }
    const docs = await this.actions
      .find(
        this.tenantFilter({
          sessionId,
          actionId: { $in: limited },
        }),
      )
      .limit(ANSWER_COLLECTION_LIMIT)
      .lean()
      .exec();

    const sanitized = docs.map((doc) => {
      const cleaned = this.sanitizeForAnswer(doc);
      const nodeId =
        typeof doc?.actionId === 'string'
          ? nodeLookup.get(doc.actionId)
          : undefined;
      if (nodeId) {
        (cleaned as Record<string, any>).nodeId = nodeId;
      }
      return cleaned;
    });

    return this.orderDocs(
      sanitized,
      limited,
      (doc) => (doc as any)?.actionId ?? undefined,
    );
  }

  private async loadRequestsForIds(
    sessionId: string,
    rids: string[],
    nodeLookup: Map<string, string>,
  ): Promise<any[]> {
    const limited = rids.slice(0, ANSWER_COLLECTION_LIMIT);
    if (!limited.length) {
      return [];
    }
    const docs = await this.requests
      .find(
        this.tenantFilter({
          sessionId,
          rid: { $in: limited },
        }),
      )
      .limit(ANSWER_COLLECTION_LIMIT)
      .lean()
      .exec();

    const sanitized = docs.map((doc) => {
      const hydrated = hydrateRequestDoc(doc);
      const cleaned = this.sanitizeForAnswer(hydrated);
      const nodeId =
        typeof doc?.rid === 'string' ? nodeLookup.get(doc.rid) : undefined;
      if (nodeId) {
        (cleaned as Record<string, any>).nodeId = nodeId;
      }
      return cleaned;
    });

    return this.orderDocs(
      sanitized,
      limited,
      (doc) => (doc as any)?.rid ?? undefined,
    );
  }

  private async loadChangesForIds(
    sessionId: string,
    changeIds: string[],
    nodeLookup: Map<string, string>,
  ): Promise<any[]> {
    const limited = changeIds.slice(0, ANSWER_COLLECTION_LIMIT);
    if (!limited.length) {
      return [];
    }
    const docs = await this.changes
      .find(
        this.tenantFilter({
          sessionId,
          _id: { $in: limited },
        }),
      )
      .limit(ANSWER_COLLECTION_LIMIT)
      .lean()
      .exec();

    const sanitized = docs.map((doc) => {
      const hydrated = hydrateChangeDoc(doc);
      const cleaned = this.sanitizeForAnswer(hydrated);
      const changeId = this.normalizeId(doc?._id);
      const nodeId = changeId ? nodeLookup.get(changeId) : undefined;
      if (nodeId) {
        (cleaned as Record<string, any>).nodeId = nodeId;
      }
      return cleaned;
    });

    return this.orderDocs(
      sanitized,
      limited,
      (doc) => (doc as any)?.id ?? this.normalizeId((doc as any)?._id),
    );
  }

  private async loadTracesForIds(
    sessionId: string,
    requestRids: string[],
    traceRequestRefs: Map<string, string>,
  ): Promise<any[]> {
    const limitedRids = requestRids.slice(0, ANSWER_COLLECTION_LIMIT);
    if (!limitedRids.length) {
      return [];
    }

    const docs = await this.traces
      .find(
        this.tenantFilter({
          sessionId,
          requestRid: { $in: limitedRids },
        }),
      )
      .limit(ANSWER_COLLECTION_LIMIT)
      .lean()
      .exec();

    const sanitized = docs.map((doc) => {
      const cleaned = this.sanitizeForAnswer(doc);
      if ('data' in cleaned) {
        delete (cleaned as Record<string, any>).data;
      }
      const nodeId =
        doc.requestRid && traceRequestRefs.get(String(doc.requestRid));
      if (nodeId) {
        (cleaned as Record<string, any>).nodeId = nodeId;
      }
      return cleaned;
    });

    return this.orderDocs(
      sanitized,
      limitedRids,
      (doc) => (doc as any)?.requestRid ?? undefined,
    );
  }

  private extractCoreRef(
    node: SessionGraphNode,
  ):
    | { collection: 'actions'; key: string; sourceId?: string }
    | { collection: 'requests'; key: string; sourceId?: string }
    | { collection: 'changes'; key: string; sourceId?: string }
    | {
        collection: 'traces';
        key?: string;
        sourceId?: string;
        chunkId?: string;
        segmentHash?: string;
        traceId?: string;
        requestRid?: string;
      }
    | undefined {
    const structured = node.structured ?? {};
    if (node.type === 'action') {
      const actionId =
        (structured as any)?.actionId ??
        node.sourceId ??
        this.stripPrefix(node._id, 'action:');
      if (actionId) {
        return {
          collection: 'actions',
          key: String(actionId),
          sourceId: node.sourceId,
        };
      }
    }
    if (node.type === 'request') {
      const rid =
        (structured as any)?.rid ??
        node.sourceId ??
        this.stripPrefix(node._id, 'request:');
      if (rid) {
        return {
          collection: 'requests',
          key: String(rid),
          sourceId: node.sourceId,
        };
      }
    }
    if (node.type === 'change') {
      const changeId =
        node.sourceId ??
        this.normalizeId((structured as any)?._id) ??
        this.stripPrefix(node._id, 'change:');
      if (changeId) {
        return {
          collection: 'changes',
          key: String(changeId),
          sourceId: node.sourceId,
        };
      }
    }
    if (node.type === 'trace_span') {
      const chunkId =
        typeof (structured as any)?.chunkId === 'string'
          ? (structured as any).chunkId
          : undefined;
      const segmentHash =
        typeof node.sourceId === 'string'
          ? node.sourceId
          : typeof (structured as any)?.segmentHash === 'string'
            ? (structured as any).segmentHash
            : undefined;
      const traceId =
        typeof (structured as any)?.traceId === 'string'
          ? (structured as any).traceId
          : typeof (structured as any)?.groupId === 'string'
            ? (structured as any).groupId
            : undefined;
      const requestRid =
        typeof (structured as any)?.requestRid === 'string'
          ? (structured as any).requestRid
          : undefined;
      const key = chunkId ?? segmentHash ?? traceId ?? requestRid;
      if (key) {
        return {
          collection: 'traces',
          key: String(key),
          sourceId: node.sourceId,
          chunkId: chunkId ?? undefined,
          segmentHash,
          traceId,
          requestRid,
        };
      }
    }
    return undefined;
  }

  private sanitizeForAnswer<T>(doc: T): T {
    if (Array.isArray(doc)) {
      return doc.map((item) => this.sanitizeForAnswer(item)) as unknown as T;
    }
    if (!doc || typeof doc !== 'object') {
      return doc;
    }
    if (Buffer.isBuffer(doc)) {
      return doc.toString('utf8') as unknown as T;
    }
    if (doc instanceof Date) {
      return doc.toISOString() as unknown as T;
    }
    const cloned: Record<string, any> = {};
    Object.entries(doc as Record<string, any>).forEach(([key, value]) => {
      if (key === 'tenantId' || key === '__v') {
        return;
      }
      if (key === '_id') {
        cloned.id = this.normalizeId(value);
        return;
      }
      const sanitized = this.sanitizeForAnswer(value);
      cloned[key] = sanitized;
    });
    return cloned as T;
  }

  private countCollections(
    collections: CoreCollections,
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    (
      ['actions', 'requests', 'traces', 'changes'] as CoreCollectionName[]
    ).forEach((collection) => {
      const docs = collections[collection];
      if (Array.isArray(docs)) {
        counts[collection] = docs.length;
      }
    });
    return counts;
  }

  private orderDocs<T>(
    docs: T[],
    order: string[],
    keySelector: (doc: T) => string | undefined,
  ): T[] {
    if (!docs.length) {
      return docs;
    }
    if (!order.length) {
      return docs;
    }
    const rank = new Map<string, number>();
    order.forEach((key, idx) => {
      rank.set(key, idx);
    });
    return [...docs].sort((a, b) => {
      const aKey = keySelector(a);
      const bKey = keySelector(b);
      const aRank =
        typeof aKey === 'string' && rank.has(aKey)
          ? (rank.get(aKey) as number)
          : Number.MAX_SAFE_INTEGER;
      const bRank =
        typeof bKey === 'string' && rank.has(bKey)
          ? (rank.get(bKey) as number)
          : Number.MAX_SAFE_INTEGER;
      if (aRank === bRank) {
        return 0;
      }
      return aRank - bRank;
    });
  }

  private collectionsToToon(collections: CoreCollections): string | undefined {
    const payload: Record<string, any> = {};
    (
      ['actions', 'requests', 'traces', 'changes'] as CoreCollectionName[]
    ).forEach((collection) => {
      const docs = collections[collection];
      if (Array.isArray(docs) && docs.length) {
        payload[collection] = docs;
      }
    });
    if (!Object.keys(payload).length) {
      return undefined;
    }
    try {
      return encode(payload, { keyFolding: 'safe' });
    } catch (err: any) {
      this.logger.warn(
        'Failed to encode OpenAI context as TOON',
        err?.message ?? err,
      );
      return JSON.stringify(payload, this.promptReplacer, 2);
    }
  }

  private promptReplacer(_key: string, value: any): any {
    if (Buffer.isBuffer(value)) {
      return value.toString('utf8');
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  }

  private normalizeId(value: any): string | undefined {
    if (typeof value === 'undefined' || value === null) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && typeof value.toString === 'function') {
      return value.toString();
    }
    return String(value);
  }

  private stripPrefix(
    value: string | undefined,
    prefix: string,
  ): string | undefined {
    if (!value?.startsWith(prefix)) {
      return undefined;
    }
    return value.slice(prefix.length);
  }

  private normalizeAnswer(
    answer: ReproAiAnswer,
    facts: Array<{ nodeId: string; nodeType: string }>,
  ): ReproAiAnswer {
    const clampStrings = (list: string[]) =>
      list
        .slice(0, ANSWER_LIST_LIMIT)
        .map((line) => this.truncate(line, ANSWER_STRING_LIMIT));

    const clampFollowUps = (list: string[]) =>
      list
        .slice(0, 3)
        .map((line) => this.truncate(line, ANSWER_STRING_LIMIT));

    const clampEvidence = (
      items: Array<{
        nodeId: string;
        nodeType: string;
        why?: string;
        title?: string;
        score?: number;
        capabilityTags?: string[];
      }>,
    ) =>
      items
        .slice(0, ANSWER_LIST_LIMIT)
        .map((ev) => ({
          nodeId: ev.nodeId,
          nodeType: ev.nodeType,
          why: ev.why ? this.truncate(ev.why, ANSWER_STRING_LIMIT) : undefined,
          title: ev.title ? this.truncate(ev.title, ANSWER_STRING_LIMIT) : undefined,
          score: ev.score,
          capabilityTags: ev.capabilityTags ?? [],
        }));

    return {
      summary:
        this.truncate(answer.summary?.trim() || 'No summary available.', ANSWER_STRING_LIMIT),
      details: Array.isArray(answer.details)
        ? clampStrings(
            answer.details.filter((line) => typeof line === 'string' && line.trim()),
          )
        : [],
      evidence: Array.isArray(answer.evidence)
        ? clampEvidence(
            answer.evidence
              .map((ev) => ({
                nodeId: ev.nodeId,
                nodeType: ev.nodeType,
                why: ev.why,
                title: ev.title,
                score: ev.score,
                capabilityTags: ev.capabilityTags ?? [],
              }))
            .filter(
              (ev) =>
                typeof ev.nodeId === 'string' &&
                typeof ev.nodeType === 'string',
            ),
          )
        : facts.map((fact) => ({
            nodeId: fact.nodeId,
            nodeType: fact.nodeType,
            why: 'Included as retrieved context.',
          })),
      uncertainties: Array.isArray(answer.uncertainties)
        ? clampStrings(
            answer.uncertainties.filter(
              (item) => typeof item === 'string' && item.trim(),
            ),
          )
        : [],
      suggestedFollowUps: Array.isArray(answer.suggestedFollowUps)
        ? clampFollowUps(
            answer.suggestedFollowUps.filter(
              (item) => typeof item === 'string' && item.trim(),
            ),
          )
        : [],
    };
  }

  private buildFallbackAnswer(
    question: string,
    facts: Array<{
      nodeId: string;
      nodeType: string;
      title?: string;
      text?: string;
      capabilityTags?: string[];
    }>,
  ): ReproAiAnswer {
    if (!facts.length) {
      return {
        summary: 'No indexed context matched directly.',
        details: [
          'Searched actions, requests, traces, and changes for this session.',
          'No overlapping capability tags or text fragments were found.',
        ],
        evidence: [],
        uncertainties: [
          'Context may be missing from the index or described with different terminology.',
        ],
        suggestedFollowUps: [
          'Provide a function name, endpoint, or collection related to your question.',
        ],
      };
    }

    const top = facts[0];
    return {
      summary: `Best guess: ${top.title ?? top.nodeId} may relate to "${question}".`,
      details: facts
        .slice(0, 3)
        .map(
          (fact) =>
            `${fact.title ?? fact.nodeId} (${fact.nodeType})${
              fact.capabilityTags?.length
                ? ` [${fact.capabilityTags.join(', ')}]`
                : ''
            }`,
        ),
      evidence: facts.map((fact) => ({
        nodeId: fact.nodeId,
        nodeType: fact.nodeType,
        why: 'Retrieved as most similar context.',
      })),
      uncertainties: [
        'Answer generated without an LLM because the model was unavailable.',
      ],
      suggestedFollowUps: [
        'Ask about a specific function, endpoint, or capability to refine the search.',
      ],
    };
  }

  private tenantFilter<T extends Record<string, any>>(filter: T): T {
    const tenantId = this.tenant.tryGetTenantId?.() ?? undefined;
    return tenantId ? { ...filter, tenantId } : filter;
  }

  private isErrorStatus(status?: number): boolean {
    return typeof status === 'number' && status >= 400;
  }

  private truncate(value: string | undefined, limit: number): string {
    if (!value) return '';
    return value.length <= limit ? value : `${value.slice(0, limit)}...`;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/gi)
      .filter(Boolean);
  }

  private lexicalScore(question: string, text: string): number {
    const qTokens = this.tokenize(question);
    const tSet = new Set(this.tokenize(text));
    if (!qTokens.length || !tSet.size) {
      return 0;
    }
    const matches = qTokens.filter((token) => tSet.has(token));
    return matches.length / Math.max(qTokens.length, 3);
  }

  private cosineSimilarity(a?: number[], b?: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const va = a[i];
      const vb = b[i];
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    if (!normA || !normB) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private normalizeEmbeddingText(text: string): string {
    const normalized = text?.trim() ?? '';
    if (normalized.length <= EMBEDDING_INPUT_LIMIT) {
      return normalized;
    }
    return normalized.slice(0, EMBEDDING_INPUT_LIMIT);
  }

  private async embedQuestion(text: string): Promise<number[] | undefined> {
    const embeddings = await this.embedTexts([
      this.normalizeEmbeddingText(text),
    ]);
    return embeddings[0];
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const normalized = texts.map((text) =>
      this.normalizeEmbeddingText(text.length ? text : ' '),
    );
    const outputs: number[][] = [];
    if (!normalized.length) {
      return outputs;
    }

    try {
      const voyageKey = this.config.get<string>('VOYAGE_API_KEY')?.trim();
      if (voyageKey) {
        const model =
          this.config.get<string>('VOYAGE_EMBEDDING_MODEL')?.trim() ??
          'voyage-large-2';
        const client = this.ensureVoyage();
        const batches = this.chunkArray(normalized, EMBEDDING_BATCH_SIZE);
        for (const batch of batches) {
          const response = await client.embed({
            input: batch,
            model,
          }, { timeoutInSeconds: Math.ceil(EMBEDDING_TIMEOUT_MS / 1000) });
          const data = response.data ?? [];
          if (data.length !== batch.length) {
            throw new Error(
              `Voyage embedding size mismatch (${data.length} vs ${batch.length})`,
            );
          }
          data.forEach((item) => outputs.push(item.embedding ?? []));
        }
        if (outputs.length === normalized.length) {
          return outputs;
        }
        this.logger.warn(
          `Voyage embedding returned ${outputs.length} vectors for ${normalized.length} inputs; falling back to OpenAI.`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Voyage embedding failed: ${err?.message ?? err}. Falling back to OpenAI.`,
      );
      outputs.length = 0;
    }

    try {
      const model =
        this.config.get<string>('OPENAI_EMBEDDING_MODEL')?.trim() ??
        'text-embedding-3-small';
      const client = this.ensureOpenAI();
      const batches = this.chunkArray(normalized, EMBEDDING_BATCH_SIZE);
      for (const batch of batches) {
        const response = await client.embeddings.create({
          model,
          input: batch,
        }, { timeout: EMBEDDING_TIMEOUT_MS });
        const data = response.data ?? [];
        if (data.length !== batch.length) {
          throw new Error(
            `OpenAI embedding size mismatch (${data.length} vs ${batch.length})`,
          );
        }
        data.forEach((entry) => outputs.push(entry.embedding ?? []));
      }
      return outputs;
    } catch (err: any) {
      this.logger.warn(
        `OpenAI embedding failed: ${err?.message ?? err}.`,
      );
    }

    return normalized.map(() => []);
  }

  private pushFact(
    list: Array<SessionFact & { embedding?: number[] }>,
    seen: Set<string>,
    fact: SessionFact & { embedding?: number[] },
  ) {
    if (!fact?._id) {
      return;
    }
    if (seen.has(fact._id)) {
      return;
    }
    seen.add(fact._id);
    list.push(fact);
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    if (size <= 0) return [items];
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      result.push(items.slice(i, i + size));
    }
    return result;
  }

  private ensureVoyage(): VoyageAIClient {
    if (this.voyage) {
      return this.voyage;
    }
    const apiKey = this.config.get<string>('VOYAGE_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        'VOYAGE_API_KEY must be configured for embeddings.',
      );
    }
    this.voyage = new VoyageAIClient({ apiKey });
    return this.voyage;
  }

  private ensureOpenAI(): OpenAI {
    if (this.openai) {
      return this.openai;
    }
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY must be configured for Repro AI responses.',
      );
    }
    this.openai = new OpenAI({ apiKey });
    return this.openai;
  }

  private tryParseJson<T>(text?: string | null): T | undefined {
    if (!text) return undefined;
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

  private parseAnswerContent(raw?: string | null): ReproAiAnswer | undefined {
    if (!raw) return undefined;
    const tryParse = (text: string) => {
      try {
        return JSON.parse(text) as ReproAiAnswer;
      } catch {
        return undefined;
      }
    };

    const trimmed = raw.trim();
    const direct = tryParse(trimmed);
    if (direct) {
      return direct;
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      const fenced = tryParse(fencedMatch[1]);
      if (fenced) {
        return fenced;
      }
    }

    const cleanedFences = trimmed
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const cleaned = tryParse(cleanedFences);
    if (cleaned) {
      return cleaned;
    }

    return this.tryParseJson<ReproAiAnswer>(trimmed);
  }
}
