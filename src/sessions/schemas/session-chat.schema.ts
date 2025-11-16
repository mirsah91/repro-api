import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SessionChatRole = 'system' | 'user' | 'assistant';

@Schema({ collection: 'sessionChatMessages' })
export class SessionChatMessage {
  @Prop({ index: true })
  tenantId: string;

  @Prop({ index: true })
  sessionId: string;

  @Prop({ index: true })
  appId?: string;

  @Prop({ enum: ['system', 'user', 'assistant'], required: true })
  role: SessionChatRole;

  @Prop({ type: String, required: true })
  content: string;

  @Prop({ type: Number, default: 0 })
  tokenEstimate: number;

  @Prop({ type: Date, default: () => new Date(), index: true })
  createdAt: Date;
}

export type SessionChatMessageDocument = HydratedDocument<SessionChatMessage>;
export const SessionChatMessageSchema =
  SchemaFactory.createForClass(SessionChatMessage);

SessionChatMessageSchema.index(
  { tenantId: 1, sessionId: 1, createdAt: 1 },
  { name: 'tenant_session_chat_history' },
);
