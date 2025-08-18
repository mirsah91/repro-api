import { ApiProperty } from '@nestjs/swagger';

export class ActionDto {
    @ApiProperty({ example: 'S_...' }) sessionId!: string;
    @ApiProperty({ example: 'A1' }) actionId!: string;
    @ApiProperty({ example: 'Click • Apply' }) label?: string;
    @ApiProperty({ example: 1710000000200 }) tStart?: number;
    @ApiProperty({ example: 1710000000300 }) tEnd?: number;
    @ApiProperty({ example: true }) hasReq!: boolean;
    @ApiProperty({ example: true }) hasDb!: boolean;
    @ApiProperty({ example: false }) error!: boolean;
    @ApiProperty({ example: { kind: 'click', target: '#btn' } }) ui?: Record<string, any>;
}
export class SummaryRespDto {
    @ApiProperty({ example: 'S_...' }) sessionId!: string;
    @ApiProperty({ example: 'APP_...' }) appId?: string;
    @ApiProperty({ type: [ActionDto] }) actions!: ActionDto[];
    @ApiProperty({ example: {} }) env!: Record<string, any>;
}

export class RequestEvtDto {
    @ApiProperty({ example: 'S_...' }) sessionId!: string;
    @ApiProperty({ example: 'A1' }) actionId!: string;
    @ApiProperty({ example: 'R12' }) rid!: string;
    @ApiProperty({ example: 'POST' }) method!: string;
    @ApiProperty({ example: '/api/apply' }) url!: string;
    @ApiProperty({ example: 500 }) status!: number;
    @ApiProperty({ example: 312 }) durMs!: number;
    @ApiProperty({ example: 1710000000280 }) t!: number;
    @ApiProperty({ example: {} }) headers?: Record<string, any>;
}
export class DbChangeDto {
    @ApiProperty({ example: 'S_...' }) sessionId!: string;
    @ApiProperty({ example: 'A1' }) actionId!: string;
    @ApiProperty({ example: 'orders' }) collection!: string;
    @ApiProperty({ example: { _id: '64...' } }) pk!: Record<string, any>;
    @ApiProperty({ example: { status: 'PENDING' }, nullable: true }) before?: Record<string, any> | null;
    @ApiProperty({ example: { status: 'FAILED' }, nullable: true }) after?: Record<string, any> | null;
    @ApiProperty({ example: 'update' }) op!: string;
    @ApiProperty({ example: 1710000000285 }) t!: number;
}
export class ActionDetailsRespDto {
    @ApiProperty({ example: { kind: 'click', target: '#btn' } }) ui!: Record<string, any>;
    @ApiProperty({ type: [RequestEvtDto] }) requests!: RequestEvtDto[];
    @ApiProperty({ type: [DbChangeDto] }) db!: DbChangeDto[];
}
