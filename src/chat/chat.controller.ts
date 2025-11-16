import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { ChatService, ChatMessage } from './chat.service';
import {
  ChatHistoryResponseDto,
  ChatMessageDto,
  SendChatMessageDto,
} from './dto/chat-message.dto';

@ApiTags('chat')
@Controller('v1/chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post(':conversationId/messages')
  @ApiParam({
    name: 'conversationId',
    description: 'Identifier for the chat stream/session.',
  })
  @ApiBody({ type: SendChatMessageDto })
  @ApiOkResponse({ type: ChatHistoryResponseDto })
  async addMessage(
    @Param('conversationId') conversationId: string,
    @Body() body: SendChatMessageDto,
  ): Promise<ChatHistoryResponseDto> {
    const history = await this.chat.appendMessage(
      conversationId,
      body.role ?? 'user',
      body.content,
    );
    return this.toResponse(conversationId, history);
  }

  @Get(':conversationId/messages')
  @ApiParam({
    name: 'conversationId',
    description: 'Identifier for the chat stream/session.',
  })
  @ApiOkResponse({ type: ChatHistoryResponseDto })
  async history(
    @Param('conversationId') conversationId: string,
  ): Promise<ChatHistoryResponseDto> {
    const history = await this.chat.getHistory(conversationId);
    return this.toResponse(conversationId, history);
  }

  private toResponse(
    conversationId: string,
    history: ChatMessage[],
  ): ChatHistoryResponseDto {
    const serialized: ChatMessageDto[] = history.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    }));
    return { conversationId, history: serialized };
  }
}
