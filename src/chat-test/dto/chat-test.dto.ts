import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type QueryPlanColumn = { field: string; title: string; type?: string };
export type QueryPlanMeta = {
  collection: string;
  type: string;
  columns: QueryPlanColumn[];
};
export type QueryPlan = { query: any[]; meta: QueryPlanMeta };

export class ChatTestRequestDto {
  @ApiProperty({
    example: 'List the last 5 requests with status >= 500 for session SESSION_123',
  })
  question!: string;
}

export class ChatTestResponseDto {
  @ApiProperty({ example: 'List the last 5 requests with status >= 500 for session SESSION_123' })
  question!: string;

  @ApiProperty({ example: 'gpt-4o-mini' })
  model!: string;

  @ApiProperty({
    description: 'Raw completion text from the language model.',
    example:
      '<!--\\n{ \"query\": [ { \"$match\": { \"sessionId\": \"SESSION_123\" } } ], \"meta\": { \"collection\": \"requests\", \"type\": \"aggregate\", \"columns\": [ { \"field\": \"url\", \"title\": \"URL\" } ] } }\\n--!>',
  })
  raw!: string;

  @ApiPropertyOptional({
    description: 'Parsed JSON plan if the response was valid JSON.',
  })
  plan?: QueryPlan;

  @ApiPropertyOptional({
    description: 'Aggregate pipeline that was executed (tenant filter injected when absent).',
  })
  pipeline?: any[];

  @ApiPropertyOptional({
    description: 'Target collection for the pipeline.',
    example: 'requests',
  })
  collection?: string;

  @ApiPropertyOptional({
    description: 'Tenant id used to scope the query.',
    example: 'TENANT_123',
  })
  tenantId?: string;

  @ApiPropertyOptional({
    description: 'Results returned by the aggregate pipeline.',
  })
  results?: any[];
}
