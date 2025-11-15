import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ChatRole } from '../chat.service';

export class SendChatMessageDto {
  @ApiProperty({
    enum: ['system', 'user', 'assistant'],
    example: 'user',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsIn(['system', 'user', 'assistant'])
  role?: ChatRole;

  @ApiProperty({ example: 'Hey team, what happened in the last deploy?' })
  @IsString()
  content!: string;
}

export class ChatMessageDto {
  @ApiProperty({ example: 'a1058d1c-3b32-4db0-ba5d-7355051ff01a' })
  id!: string;

  @ApiProperty({
    enum: ['system', 'user', 'assistant'],
    example: 'assistant',
  })
  role!: ChatRole;

  @ApiProperty({
    example: 'Checkout started failing after the shipping service upgrade.',
  })
  content!: string;

  @ApiProperty({ example: '2024-01-15T12:34:56.000Z' })
  createdAt!: string;
}

export class ChatHistoryResponseDto {
  @ApiProperty({ example: 'conversation-123' })
  conversationId!: string;

  @ApiProperty({ type: [ChatMessageDto] })
  history!: ChatMessageDto[];
}
