import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartSessionDto {
  @ApiPropertyOptional({
    example: 1710000000000,
    description: 'epoch ms from client',
  })
  clientTime?: number;
}
export class StartSessionRespDto {
  @ApiProperty({ example: 'S_8b6e...' }) sessionId!: string;
  @ApiProperty({ example: 0 }) clockOffsetMs!: number;
}

export class RrwebEventDto {
  @ApiProperty({ example: 'rrweb' }) type!: 'rrweb';
  @ApiProperty({ example: 1710000000100 }) t!: number;
  @ApiProperty({ example: '{"type":0,"data":{...}}' }) chunk!: string;
}
export class ActionEventDto {
  @ApiProperty({ example: 'action' }) type!: 'action';
  @ApiProperty({ example: 'A1' }) aid!: string;
  @ApiPropertyOptional({ example: 'Click • Apply' }) label?: string;
  @ApiProperty({ example: 1710000000200 }) tStart!: number;
  @ApiProperty({ example: 1710000000300 }) tEnd!: number;
  @ApiProperty({ example: true }) hasReq!: boolean;
  @ApiProperty({ example: true }) hasDb!: boolean;
  @ApiProperty({ example: false }) error!: boolean;
  @ApiProperty({ example: { kind: 'click', target: '#btn' } }) ui!: Record<
    string,
    any
  >;
}
export class NetEventDto {
  @ApiProperty({ example: 'net' }) type!: 'net';
  @ApiProperty({ example: 'A1' }) aid!: string;
  @ApiProperty({ example: 'R12' }) rid!: string;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: '/api/apply' }) url!: string;
  @ApiProperty({ example: 500 }) status!: number;
  @ApiProperty({ example: 312 }) durMs!: number;
  @ApiProperty({ example: 1710000000280 }) t!: number;
  @ApiProperty({ example: { 'content-type': 'application/json' } })
  headers?: Record<string, any>;
}
export class AppendEventsDto {
  @ApiProperty({ example: 123 }) seq!: number;
  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getRef(RrwebEventDto) },
        { $ref: getRef(ActionEventDto) },
        { $ref: getRef(NetEventDto) },
      ],
    },
  } as any)
  events!: Array<RrwebEventDto | ActionEventDto | NetEventDto>;
}
function getRef(cls: any) {
  return { $ref: `#/components/schemas/${cls.name}` };
}

export class BackendRequestDto {
  @ApiProperty({ example: 'R12' }) rid!: string;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: '/api/apply' }) path?: string;
  @ApiProperty({ example: 500 }) status!: number;
  @ApiProperty({ example: 312 }) durMs!: number;
  @ApiProperty({ example: {} }) headers?: Record<string, any>;
  @ApiPropertyOptional({
    description: 'Captured request body (sanitized JSON if available)',
    type: Object,
    additionalProperties: true,
  })
  body?: any;
  @ApiPropertyOptional({
    description: 'Route parameters provided by the framework',
    type: Object,
    additionalProperties: true,
  })
  params?: Record<string, any>;
  @ApiPropertyOptional({
    description: 'Query string parameters parsed by the framework',
    type: Object,
    additionalProperties: true,
  })
  query?: Record<string, any>;
}
export class BackendDbChangeDto {
  @ApiProperty({ example: 'orders' }) collection!: string;
  @ApiProperty({ example: { _id: '64fabc...' } }) pk!: Record<string, any>;
  @ApiProperty({ example: { status: 'PENDING' }, nullable: true })
  before?: Record<string, any> | null;
  @ApiProperty({ example: { status: 'FAILED' }, nullable: true })
  after?: Record<string, any> | null;
  @ApiProperty({ example: 'update', enum: ['insert', 'update', 'delete'] })
  op!: 'insert' | 'update' | 'delete';
  @ApiPropertyOptional({
    description: 'Trace/span context for correlating DB change to a function trace',
    example: { traceId: 't1', spanId: 42, parentSpanId: 41, depth: 3 },
  })
  spanContext?: {
    traceId?: string | null;
    spanId?: string | number | null;
    parentSpanId?: string | number | null;
    depth?: number | null;
  };
}
export class BackendTraceBatchDto {
  @ApiProperty({ example: 'R12' }) rid!: string;
  @ApiProperty({ example: 0 }) index!: number;
  @ApiPropertyOptional({ example: 3 }) total?: number;
}

export class BackendEntryDto {
  @ApiProperty({ example: 'A1' }) actionId!: string;
  @ApiPropertyOptional({ type: BackendRequestDto }) request?: BackendRequestDto;
  @ApiPropertyOptional({
    description:
      'Trace events captured for the batch (stringified JSON or object)',
    example: '[{"t":0,"type":"enter"}]',
  })
  trace?: any;
  @ApiPropertyOptional({ type: BackendTraceBatchDto })
  traceBatch?: BackendTraceBatchDto;
  @ApiPropertyOptional({ type: [BackendDbChangeDto] })
  db?: BackendDbChangeDto[];
  @ApiProperty({ example: 1710000000285 }) t!: number;
}
export class BackendIngestDto {
  @ApiProperty({ type: [BackendEntryDto] }) entries!: BackendEntryDto[];
}

export class FinishSessionDto {
  @ApiPropertyOptional({ example: 'Steps to repro…' }) notes?: string;
}
export class FinishSessionRespDto {
  @ApiProperty({ example: 'https://repro.app/s/S_...' }) viewerUrl!: string;
}

export class AppSessionDto {
  @ApiProperty({ example: 'S_8b6e...' })
  sessionId!: string;

  @ApiProperty({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
  appId!: string;

  @ApiPropertyOptional({ example: '2024-03-20T15:30:00.000Z' })
  startedAt?: Date;

  @ApiPropertyOptional({ example: '2024-03-20T15:42:00.000Z' })
  finishedAt?: Date;

  @ApiPropertyOptional({ example: 'Login form froze on submit' })
  notes?: string;

  @ApiPropertyOptional({ example: 'qa@example.com' })
  userEmail?: string;

  @ApiPropertyOptional({ example: '65f8e63c8a7a2c1d9c5e4f12' })
  userId?: string;

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: true,
    example: { browser: 'Chrome 123', os: 'macOS' },
  })
  env?: Record<string, any>;

  @ApiPropertyOptional({ example: '2024-03-20T15:30:05.000Z' })
  createdAt?: Date;

  @ApiPropertyOptional({ example: '2024-03-20T15:45:00.000Z' })
  updatedAt?: Date;
}

export class SessionListResponseDto {
  @ApiProperty({ type: [AppSessionDto] })
  items!: AppSessionDto[];

  @ApiPropertyOptional({
    description:
      'Opaque cursor to request the next page (ISO timestamp of the last session).',
    example: '2024-03-19T10:02:00.000Z',
  })
  nextCursor?: string;
}

export class CreateAppSessionDto {
  @ApiPropertyOptional({ example: 'Sign up form stuck on loader' })
  notes?: string;

  @ApiPropertyOptional({ example: 'qa@example.com' })
  userEmail?: string;

  @ApiPropertyOptional({
    example: '2024-03-20T15:30:00.000Z',
    description: 'Override the start timestamp (defaults to now).',
  })
  startedAt?: string;

  @ApiPropertyOptional({
    example: '2024-03-20T15:42:00.000Z',
    description: 'Optional end timestamp for the session.',
  })
  finishedAt?: string;

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: true,
    example: { browser: 'Chrome 123', viewport: '1440x900' },
  })
  env?: Record<string, any>;
}

export class UpdateAppSessionDto {
  @ApiPropertyOptional({ example: 'Updated notes about the bug' })
  notes?: string | null;

  @ApiPropertyOptional({ example: 'qa@example.com' })
  userEmail?: string | null;

  @ApiPropertyOptional({
    example: '2024-03-20T15:30:00.000Z',
    description: 'Override the start timestamp.',
  })
  startedAt?: string | null;

  @ApiPropertyOptional({
    example: '2024-03-20T15:42:00.000Z',
    description: 'Mark the session as finished at this time.',
  })
  finishedAt?: string | null;

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: true,
    example: { browser: 'Firefox 124' },
  })
  env?: Record<string, any> | null;
}
