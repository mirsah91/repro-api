import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReindexSessionGraphResponseDto {
  @ApiProperty({ example: 'S_abc123' })
  sessionId!: string;

  @ApiProperty({ example: 42 })
  nodes!: number;

  @ApiProperty({ example: 60 })
  edges!: number;

  @ApiProperty({ example: 80 })
  facts!: number;
}

export class ReproAiQueryDto {
  @ApiProperty({ example: 'Where are notifications sent?' })
  question!: string;

  @ApiPropertyOptional({
    description: 'Restrict retrieval to specific node types.',
    example: ['request', 'trace_span'],
    type: [String],
  })
  nodeTypes?: string[];

  @ApiPropertyOptional({
    description: 'Boost or filter by capability tags.',
    example: ['notification', 'messaging'],
    type: [String],
  })
  capabilityTags?: string[];

  @ApiPropertyOptional({
    description: 'Maximum facts to return.',
    example: 20,
  })
  limit?: number;

  @ApiPropertyOptional({
    description: 'Force a rebuild of the graph/index before answering.',
    example: false,
  })
  rebuildIndex?: boolean;
}

export class ReproAiEvidenceDto {
  @ApiProperty({ example: 'request:R1' })
  nodeId!: string;

  @ApiProperty({ example: 'request' })
  nodeType!: string;

  @ApiPropertyOptional({ example: 'POST /api/notify' })
  title?: string;

  @ApiPropertyOptional({
    description: 'Why this node is relevant to the answer.',
    example: 'Publishes message via messaging client before error.',
  })
  why?: string;

  @ApiPropertyOptional({ example: 0.78 })
  score?: number;

  @ApiPropertyOptional({ type: [String], example: ['notification', 'queue'] })
  capabilityTags?: string[];
}

export class ReproAiAnswerDto {
  @ApiProperty({
    description: 'Short headline for the answer.',
    example: 'Notifications published from sendMessage before failing to enqueue.',
  })
  summary!: string;

  @ApiProperty({
    description: 'Supporting bullets.',
    type: [String],
  })
  details!: string[];

  @ApiProperty({ type: [ReproAiEvidenceDto] })
  evidence!: ReproAiEvidenceDto[];

  @ApiProperty({
    description: 'Explicit uncertainties.',
    type: [String],
  })
  uncertainties!: string[];

  @ApiProperty({
    description: 'One or more follow-ups the user can answer.',
    type: [String],
  })
  suggestedFollowUps!: string[];
}

export class ReproAiHitDto {
  @ApiProperty({ example: 'trace:chunk-1' })
  nodeId!: string;

  @ApiProperty({ example: 'trace_span' })
  nodeType!: string;

  @ApiPropertyOptional({ example: 'sendMessage in messaging/client.js' })
  title?: string;

  @ApiPropertyOptional({ type: [String], example: ['messaging'] })
  capabilityTags?: string[];

  @ApiProperty({ example: 0.64 })
  score!: number;
}

export class ReproAiGraphNodeDto {
  @ApiProperty({ example: 'request:R1' })
  nodeId!: string;

  @ApiProperty({ example: 'request' })
  nodeType!: string;

  @ApiPropertyOptional({ example: 'POST /api/notify' })
  title?: string;

  @ApiPropertyOptional({ type: [String], example: ['notification'] })
  capabilityTags?: string[];
}

export class ReproAiGraphEdgeDto {
  @ApiProperty({ example: 'action:A1' })
  fromNodeId!: string;

  @ApiProperty({ example: 'request:R1' })
  toNodeId!: string;

  @ApiPropertyOptional({ example: 'initiates' })
  relation?: string;
}

export class ReproAiGraphDto {
  @ApiProperty({ type: [ReproAiGraphNodeDto] })
  nodes!: ReproAiGraphNodeDto[];

  @ApiProperty({ type: [ReproAiGraphEdgeDto] })
  edges!: ReproAiGraphEdgeDto[];
}

export class ReproAiQueryResponseDto {
  @ApiProperty({ example: 'S_abc123' })
  sessionId!: string;

  @ApiProperty({ example: 'Where are notifications sent?' })
  question!: string;

  @ApiProperty({ type: ReproAiAnswerDto })
  answer!: ReproAiAnswerDto;

  @ApiProperty({ type: [ReproAiHitDto] })
  hits!: ReproAiHitDto[];

  @ApiProperty({
    description: 'Subset of the graph used to answer.',
    type: ReproAiGraphDto,
  })
  graph!: ReproAiGraphDto;
}
