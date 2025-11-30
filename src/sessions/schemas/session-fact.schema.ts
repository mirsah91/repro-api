import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'session_facts_index',
  _id: false,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
})
export class SessionFact {
  @Prop({ type: String })
  _id!: string;

  @Prop({ index: true })
  tenantId!: string;

  @Prop({ index: true, required: true })
  sessionId!: string;

  @Prop({ required: true })
  nodeId!: string;

  @Prop({ required: true })
  nodeType!: string;

  @Prop({ required: true })
  text!: string;

  @Prop({ type: Object })
  structured?: Record<string, any>;

  @Prop({ type: [String], default: [] })
  capabilityTags!: string[];

  @Prop({ type: Object })
  scoreSignals?: Record<string, any>;

  @Prop({ type: [Number], default: [] })
  embedding?: number[];
}

export type SessionFactDocument = HydratedDocument<SessionFact>;
export const SessionFactSchema = SchemaFactory.createForClass(SessionFact);

SessionFactSchema.index({ tenantId: 1, sessionId: 1 });
SessionFactSchema.index({ tenantId: 1, sessionId: 1, nodeType: 1 });
SessionFactSchema.index({ tenantId: 1, sessionId: 1, capabilityTags: 1 });
