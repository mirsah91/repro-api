import { ApiProperty } from '@nestjs/swagger';

export class BootstrapOkDto {
    @ApiProperty({ example: true }) enabled!: boolean;
    @ApiProperty({ example: '8e4f2a2d-...' }) sdkToken!: string;
    @ApiProperty({ example: { maskSelectors: [], maxMinutes: 5 } })
    capture!: Record<string, any>;
}
export class BootstrapDisabledDto {
    @ApiProperty({ example: false }) enabled!: boolean;
}
