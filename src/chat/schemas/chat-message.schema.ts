import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ChatRole } from '../chat.service';

@Schema({ collection: 'chat_messages', timestamps: true })
export class ChatMessageModel {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ enum: ['system', 'user', 'assistant'], required: true })
  role!: ChatRole;

  @Prop({ type: String, required: true })
  content!: string;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export type ChatMessageDocument = HydratedDocument<ChatMessageModel>;
export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessageModel);

ChatMessageSchema.index(
  { conversationId: 1, createdAt: 1 },
  { name: 'chat_conversation_history' },
);
