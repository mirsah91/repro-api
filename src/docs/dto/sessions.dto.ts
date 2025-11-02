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
