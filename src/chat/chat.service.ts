import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import {
  ChatMessageDocument,
  ChatMessageModel,
} from './schemas/chat-message.schema';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: Date;
};

@Injectable()
export class ChatService {
  private static readonly MAX_HISTORY_LENGTH = 50;

  constructor(
    @InjectModel(ChatMessageModel.name)
    private readonly chatMessages: Model<ChatMessageDocument>,
  ) {}

  async appendMessage(
    conversationId: string,
    role: ChatRole,
    content: string,
  ): Promise<ChatMessage[]> {
    const normalizedId = this.normalizeConversationId(conversationId);
    const trimmed = this.normalizeContent(content);
    await this.chatMessages.create({
      conversationId: normalizedId,
      role,
      content: trimmed,
    });
    return this.getHistory(normalizedId);
  }

  async getHistory(conversationId: string): Promise<ChatMessage[]> {
    const normalizedId = this.normalizeConversationId(conversationId);
    const docs = await this.chatMessages
      .find({ conversationId: normalizedId })
      .sort({ createdAt: -1 })
      .limit(ChatService.MAX_HISTORY_LENGTH)
      .lean()
      .exec();
    return docs.reverse().map((doc) => ({
      id: doc._id ? String(doc._id) : randomUUID(),
      role: doc.role,
      content: doc.content,
      createdAt: new Date(doc.createdAt ?? Date.now()),
    }));
  }

  private normalizeConversationId(value: string): string {
    return value?.trim() || 'default';
  }

  private normalizeContent(content: string): string {
    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed.length ? trimmed : '';
    }
    if (content === undefined || content === null) {
      return '';
    }
    return String(content);
  }
}
