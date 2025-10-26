import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class UiInfoDto {
  @ApiProperty({ required: false, example: 'click' })
  @IsOptional()
  @IsString()
  kind?: string;

  @ApiProperty({
    required: false,
    description: 'Additional UI metadata',
    type: Object,
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  // eslint-disable-next-line @typescript-eslint/ban-types
  extra?: Record<string, any>;
}

export class ActionBaseDto {
  @ApiProperty()
  @IsString()
  actionId!: string | null;

  @ApiProperty()
  @IsString()
  label!: string | null;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  tStart!: number | null;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  tEnd!: number | null;

  @ApiProperty()
  @IsBoolean()
  hasReq!: boolean | null;

  @ApiProperty()
  @IsBoolean()
  hasDb!: boolean | null;

  @ApiProperty()
  @IsBoolean()
  error!: boolean | null;

  @ApiProperty({ type: UiInfoDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => UiInfoDto)
  ui?: UiInfoDto | Record<string, any>;
}

export class RequestEvtDto {
  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty()
  @IsString()
  actionId!: string;

  @ApiProperty()
  @IsString()
  rid!: string;

  @ApiProperty()
  @IsString()
  method!: string;

  // Kept for backward compat. One of url|path may be present.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiProperty()
  @IsNumber()
  status!: number;

  @ApiProperty()
  @IsNumber()
  durMs!: number;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  t!: number;

  @ApiProperty({ required: false, type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  headers?: Record<string, any>;

  @ApiProperty({
    required: false,
    description: 'Normalized grouping key (e.g. "GET /items")',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    required: false,
    description: 'Captured response body (JSON if available; may be string)',
  })
  // eslint-disable-next-line @typescript-eslint/ban-types
  respBody?: any;
}

export class DbPkDto {
  @ApiProperty()
  @IsString()
  _id!: string;
}

export enum DbOp {
  INSERT = 'insert',
  UPDATE = 'update',
  DELETE = 'delete',
}

export class DbChangeDto {
  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty()
  @IsString()
  actionId!: string;

  @ApiProperty()
  @IsString()
  collection!: string;

  @ApiProperty({ type: DbPkDto })
  @ValidateNested()
  @Type(() => DbPkDto)
  pk!: DbPkDto;

  @ApiProperty({ nullable: true, description: 'Document before' })
  before!: any;

  @ApiProperty({ nullable: true, description: 'Document after' })
  after!: any;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: true,
    description: 'Captured query details (filter/update/projection/options/pipeline)',
  })
  @IsOptional()
  @IsObject()
  query?: Record<string, any>;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: true,
    description: 'Summary of the database call result',
  })
  @IsOptional()
  @IsObject()
  resultMeta?: Record<string, any>;

  @ApiProperty({ enum: DbOp })
  @IsEnum(DbOp)
  op!: DbOp;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  t!: number;
}

export class ActionWithDetailsDto extends ActionBaseDto {
  @ApiProperty({ type: [RequestEvtDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequestEvtDto)
  requests!: RequestEvtDto[];

  @ApiProperty({ type: [DbChangeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DbChangeDto)
  db!: DbChangeDto[];
}

/** rrweb meta */
export class RrwebMetaDto {
  @ApiProperty()
  @IsNumber()
  chunks!: number;

  @ApiProperty({ nullable: true })
  @IsOptional()
  firstSeq!: number | null;

  @ApiProperty({ nullable: true })
  @IsOptional()
  lastSeq!: number | null;
}

/** Response diffs */
export enum RespChangeType {
  ADDED = 'added',
  REMOVED = 'removed',
  CHANGED = 'changed',
}

export class RespDiffChangeDto {
  @ApiProperty({ description: 'JSON path (dot or keyed for arrays)' })
  @IsString()
  path!: string;

  @ApiProperty({ enum: RespChangeType })
  @IsEnum(RespChangeType)
  type!: RespChangeType;

  @ApiProperty({ required: false, description: 'Previous value' })
  from?: any;

  @ApiProperty({ required: false, description: 'New value' })
  to?: any;
}

export class RespDiffSummaryDto {
  @ApiProperty()
  @IsNumber()
  added!: number;

  @ApiProperty()
  @IsNumber()
  removed!: number;

  @ApiProperty()
  @IsNumber()
  changed!: number;
}

export class RespDiffEdgeDto {
  @ApiProperty()
  @IsString()
  fromRid!: string;

  @ApiProperty()
  @IsString()
  toRid!: string;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  tFrom!: number;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  tTo!: number;

  @ApiProperty({ type: RespDiffSummaryDto })
  @ValidateNested()
  @Type(() => RespDiffSummaryDto)
  summary!: RespDiffSummaryDto;

  @ApiProperty({ type: [RespDiffChangeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RespDiffChangeDto)
  changes!: RespDiffChangeDto[];
}

export class RespDiffCallDto {
  @ApiProperty()
  @IsString()
  rid!: string;

  @ApiProperty({ description: 'ms since epoch' })
  @IsNumber()
  t!: number;

  @ApiProperty()
  @IsNumber()
  status!: number;

  @ApiProperty()
  @IsNumber()
  durMs!: number;
}

export class RespDiffGroupDto {
  @ApiProperty({ example: 'GET /items' })
  @IsString()
  key!: string;

  @ApiProperty({ type: [RespDiffCallDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RespDiffCallDto)
  calls!: RespDiffCallDto[];

  @ApiProperty({ type: [RespDiffEdgeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RespDiffEdgeDto)
  diffs!: RespDiffEdgeDto[];
}

/** Responses */
export class SummaryResponseDto {
  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  appId?: string;

  @ApiProperty({ type: [ActionBaseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActionBaseDto)
  actions!: ActionBaseDto[];

  @ApiProperty({ type: Object, additionalProperties: true, required: false })
  @IsOptional()
  @IsObject()
  env?: Record<string, any>;
}

export class ActionDetailsResponseDto {
  @ApiProperty({ type: Object, additionalProperties: true, required: false })
  ui!: Record<string, any>;

  @ApiProperty({ type: [RequestEvtDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequestEvtDto)
  requests!: RequestEvtDto[];

  @ApiProperty({ type: [DbChangeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DbChangeDto)
  db!: DbChangeDto[];
}

@ApiExtraModels(ActionWithDetailsDto, RrwebMetaDto, RespDiffGroupDto)
export class FullResponseDto {
  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  appId?: string;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  startedAt?: Date;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  finishedAt?: Date;

  @ApiProperty({ required: false, type: RrwebMetaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RrwebMetaDto)
  rrweb?: RrwebMetaDto;

  @ApiProperty({ type: [ActionWithDetailsDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActionWithDetailsDto)
  actions!: ActionWithDetailsDto[];

  @ApiProperty({ required: false, type: [RespDiffGroupDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RespDiffGroupDto)
  respDiffs?: RespDiffGroupDto[];
}

/** Queries */
export class FullQueryDto {
  @ApiProperty({
    required: false,
    description: 'Comma-separated flags (rrweb,respdiffs)',
    example: 'rrweb,respdiffs',
  })
  @IsOptional()
  @IsString()
  include?: string;
}

export class ActionDto {
  @ApiProperty({ example: 'S_...' }) sessionId!: string;
  @ApiProperty({ example: 'A1' }) actionId!: string;
  @ApiProperty({ example: 'Click • Apply' }) label?: string;
  @ApiProperty({ example: 1710000000200 }) tStart?: number;
  @ApiProperty({ example: 1710000000300 }) tEnd?: number;
  @ApiProperty({ example: true }) hasReq!: boolean;
  @ApiProperty({ example: true }) hasDb!: boolean;
  @ApiProperty({ example: false }) error!: boolean;
  @ApiProperty({ example: { kind: 'click', target: '#btn' } }) ui?: Record<
    string,
    any
  >;
}
export class SummaryRespDto {
  @ApiProperty({ example: 'S_...' }) sessionId!: string;
  @ApiProperty({ example: 'APP_...' }) appId?: string;
  @ApiProperty({ type: [ActionDto] }) actions!: ActionDto[];
  @ApiProperty({ example: {} }) env!: Record<string, any>;
}

export class ActionDetailsRespDto {
  @ApiProperty({ example: { kind: 'click', target: '#btn' } }) ui!: Record<
    string,
    any
  >;
  @ApiProperty({ type: [RequestEvtDto] }) requests!: RequestEvtDto[];
  @ApiProperty({ type: [DbChangeDto] }) db!: DbChangeDto[];
}
