import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppUserRole } from '../../apps/schemas/app-user.schema';

export class CreateAppDto {
    @ApiPropertyOptional({ example: 'my-first-app' })
    name?: string;

    @ApiProperty({ example: 'owner@example.com' })
    adminEmail!: string;
}

export class UpdateAppDto {
    @ApiPropertyOptional({ example: 'New App Name' })
    name?: string;

    @ApiPropertyOptional({ example: true })
    enabled?: boolean;
}

export class AppDto {
    @ApiProperty({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
    appId!: string;

    @ApiProperty({ example: 'my-first-app' })
    name!: string;

    @ApiProperty({ example: true })
    enabled!: boolean;

    @ApiPropertyOptional({ example: 'owner@example.com' })
    adminEmail?: string;

    @ApiPropertyOptional({ example: '2024-03-15T10:00:00.000Z' })
    createdAt?: Date;

    @ApiPropertyOptional({ example: '2024-03-16T15:30:00.000Z' })
    updatedAt?: Date;
}

export class AppDetailDto extends AppDto {
    @ApiProperty({ example: '5f1f6f9b-3e6a-4b9d-8a2b-9b0f7d' })
    appSecret!: string;
}

export class AppUserDto {
    @ApiProperty({ example: '65f8e63c8a7a2c1d9c5e4f12' })
    id!: string;

    @ApiProperty({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
    appId!: string;

    @ApiProperty({ example: 'user@example.com' })
    email!: string;

    @ApiProperty({ enum: AppUserRole, example: AppUserRole.Viewer })
    role!: AppUserRole;

    @ApiProperty({ example: 'c0a801b2-5c0d-4c7d-9f1f-1234567890ab' })
    token!: string;

    @ApiProperty({ example: true })
    enabled!: boolean;

    @ApiPropertyOptional({ example: 'Casey Jones' })
    name?: string;

    @ApiPropertyOptional({ example: '2024-03-15T10:00:00.000Z' })
    createdAt?: Date;

    @ApiPropertyOptional({ example: '2024-03-16T15:30:00.000Z' })
    updatedAt?: Date;
}

export class CreateAppUserDto {
    @ApiProperty({ example: 'user@example.com' })
    email!: string;

    @ApiPropertyOptional({ enum: AppUserRole, example: AppUserRole.Recorder })
    role?: AppUserRole;

    @ApiPropertyOptional({ example: 'Casey Jones' })
    name?: string;

    @ApiPropertyOptional({ example: true })
    enabled?: boolean;
}

export class UpdateAppUserDto {
    @ApiPropertyOptional({ enum: AppUserRole, example: AppUserRole.Viewer })
    role?: AppUserRole;

    @ApiPropertyOptional({ example: 'Casey Updated' })
    name?: string | null;

    @ApiPropertyOptional({ example: false })
    enabled?: boolean;

    @ApiPropertyOptional({ example: true })
    resetToken?: boolean;
}

export class AppKeysDto extends AppDetailDto {
    @ApiProperty({ type: AppUserDto })
    admin!: AppUserDto;
}
