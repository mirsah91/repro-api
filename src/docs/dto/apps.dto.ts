import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AppUserRole } from '../../apps/schemas/app-user.schema';

export class CreateAppDto {
  @ApiPropertyOptional({ example: 'my-first-app' })
  name?: string;

  @ApiProperty({ example: 'owner@example.com' })
  adminEmail!: string;

  @ApiPropertyOptional({
    example: 'Str0ng-and-unique!',
    minLength: 12,
    description:
      'Optional. Supply to set an explicit initial admin password instead of receiving a generated one.',
  })
  adminPassword?: string;
}

export class InitWorkspaceDto {
  @ApiProperty({ example: 'owner@example.com' })
  email!: string;

  @ApiPropertyOptional({ example: 'Acme Web' })
  appName?: string;

  @ApiProperty({
    example: 'Str0ng-and-unique!',
    minLength: 12,
    description: 'Password for the initial admin user.',
  })
  password!: string;
}

export class UpdateAppDto {
  @ApiPropertyOptional({ example: 'New App Name' })
  name?: string;

  @ApiPropertyOptional({ example: true })
  enabled?: boolean;
}

export class AppDto {
  @ApiProperty({ example: 'TENANT_9f034ad4-2b47-4e89-b273-17cf23a2b61e' })
  tenantId!: string;

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

  @ApiProperty({ example: false })
  chatEnabled!: boolean;

  @ApiPropertyOptional({ example: 3 })
  chatUsageCount?: number;

  @ApiPropertyOptional({ example: 7 })
  chatQuotaRemaining?: number;

  @ApiPropertyOptional({ example: 10 })
  chatQuotaLimit?: number;
}

export class AppDetailDto extends AppDto {
  @ApiProperty({ example: '5f1f6f9b-3e6a-4b9d-8a2b-9b0f7d' })
  appSecret!: string;

  @ApiProperty({ example: 'V0Y3d0FJc0F2QURyUWxJV0ZLQ2JJNjdjTFB6WE5xYmU=' })
  encryptionKey!: string;
}

export class AppSummaryDto extends AppDto {
  @ApiPropertyOptional({ example: '5f1f6f9b-3e6a-4b9d-8a2b-9b0f7d' })
  appSecret?: string;
}

export class AppUserDto {
  @ApiProperty({ example: '65f8e63c8a7a2c1d9c5e4f12' })
  id!: string;

  @ApiProperty({ example: 'TENANT_9f034ad4-2b47-4e89-b273-17cf23a2b61e' })
  tenantId!: string;

  @ApiProperty({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
  appId!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ enum: AppUserRole, example: AppUserRole.Viewer })
  role!: AppUserRole;

  @ApiPropertyOptional({
    example: 'c0a801b2-5c0d-4c7d-9f1f-1234567890ab',
    description:
      'Workspace password / access token returned when initially generated or reset.',
  })
  password?: string;

  @ApiPropertyOptional({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT bearer token for authenticated API requests.',
  })
  accessToken?: string;

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

  @ApiPropertyOptional({
    example: false,
    description: 'Grant access to the AI chat assistant (default disabled).',
  })
  chatEnabled?: boolean;
}

export class UpdateAppUserDto {
  @ApiPropertyOptional({ enum: AppUserRole, example: AppUserRole.Viewer })
  role?: AppUserRole;

  @ApiPropertyOptional({ example: 'Casey Updated' })
  name?: string | null;

  @ApiPropertyOptional({ example: false })
  enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Reset the user password and return the new value in the response.',
  })
  resetPassword?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Enable or disable access to the AI chat assistant.',
  })
  chatEnabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Set to true to reset the chat usage counter for the user.',
  })
  resetChatUsage?: boolean;
}

export class AppKeysDto extends AppDetailDto {
  @ApiProperty({ type: AppUserDto })
  admin!: AppUserDto;
}

export class AppUserLoginDto {
  @ApiProperty({ example: 'user@example.com' })
  email: string;

  @ApiProperty({
    example: 'c0a801b2-5c0d-4c7d-9f1f-1234567890ab',
    description: 'Workspace password issued to the user.',
  })
  password: string;
}

export class AppUserLoginResponseDto {
  @ApiProperty({ type: AppUserDto })
  user!: AppUserDto;

  @ApiProperty({ type: AppSummaryDto })
  app!: AppSummaryDto;
}

export class UpdateAppUserProfileDto {
  @ApiPropertyOptional({ example: 'user@example.com' })
  email?: string;

  @ApiPropertyOptional({ example: 'Casey Jones' })
  name?: string | null;
}

export class AppUserProfileResponseDto {
  @ApiProperty({ type: AppUserDto })
  user!: AppUserDto;
}

export class SummaryMessageDto {
  @ApiProperty({ enum: ['system', 'user', 'assistant'] })
  @IsString()
  @IsIn(['system', 'user', 'assistant'])
  role!: 'system' | 'user' | 'assistant';

  @ApiProperty({
    example: 'Why does checkout fail in cart.service.ts line 88?',
  })
  @IsString()
  content!: string;
}

export class SessionSummaryRequestDto {
  @ApiProperty({ example: 'S_123456789abcdef' })
  @IsString()
  sessionId!: string;

  @ApiPropertyOptional({ example: 'APP_3b3f8b2b-8c8e-4c7d-8a8a-83b6d2' })
  @IsOptional()
  @IsString()
  appId?: string;

  @ApiPropertyOptional({ type: [SummaryMessageDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SummaryMessageDto)
  messages?: SummaryMessageDto[];
}

export class SessionChatRequestDto {
  @ApiProperty({ type: [SummaryMessageDto] })
  @ValidateNested({ each: true })
  @Type(() => SummaryMessageDto)
  messages!: SummaryMessageDto[];
}

export class SessionSummaryResponseDto {
  @ApiProperty({ example: 'S_123456789abcdef' })
  sessionId!: string;

  @ApiProperty({ example: 'Executive Overview: ...' })
  summary!: string;

  @ApiProperty({ example: 'gpt-4o-mini' })
  model!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: {
      actions: 3,
      requests: 5,
      dbChanges: 2,
      emails: 1,
      traces: 4,
    },
  })
  counts!: Record<string, number>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: {
      promptTokens: 1200,
      completionTokens: 450,
      totalTokens: 1650,
    },
  })
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export class SessionChatResponseDto {
  @ApiProperty({
    example: 'Requests to /api/checkout began failing after the DB migration…',
  })
  reply!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: {
      actions: 3,
      requests: 5,
      dbChanges: 2,
      emails: 1,
      traces: 4,
    },
  })
  counts!: Record<string, number>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: {
      promptTokens: 800,
      completionTokens: 220,
      totalTokens: 1020,
    },
  })
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };

  @ApiPropertyOptional({
    description: 'Quota metadata describing the remaining chat prompts for the user.',
    example: {
      limit: 10,
      used: 3,
      remaining: 7,
    },
  })
  quota?: {
    limit: number;
    used: number;
    remaining: number;
  };
}
