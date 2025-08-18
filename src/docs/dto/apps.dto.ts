import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAppDto {
    @ApiPropertyOptional({ example: 'my-first-app' })
    name?: string;
}
export class AppKeysDto {
    @ApiProperty({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
    appId!: string;
    @ApiProperty({ example: '5f1f6f9b-3e6a-4b9d-8a2b-9b0f7d' })
    appSecret!: string;
}
