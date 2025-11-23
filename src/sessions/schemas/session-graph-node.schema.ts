import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'session_graph_nodes',
  _id: false,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
})
export class SessionGraphNode {
  @Prop({ type: String })
  _id!: string;

  @Prop({ index: true })
  tenantId!: string;

  @Prop({ index: true, required: true })
  sessionId!: string;

  @Prop({ required: true })
  type!: string;

  @Prop()
  sourceCollection?: string;

  @Prop()
  sourceId?: string;

  @Prop()
  title?: string;

  @Prop()
  rawText?: string;

  @Prop({ type: Object })
  structured?: Record<string, any>;

  @Prop({ type: [String], default: [] })
  capabilityTags!: string[];

  @Prop({ type: Object })
  scoreSignals?: Record<string, any>;

  @Prop()
  service?: string;

  @Prop()
  env?: string;
}

export type SessionGraphNodeDocument = HydratedDocument<SessionGraphNode>;
export const SessionGraphNodeSchema =
  SchemaFactory.createForClass(SessionGraphNode);

SessionGraphNodeSchema.index({ tenantId: 1, sessionId: 1, type: 1 });
SessionGraphNodeSchema.index({
  tenantId: 1,
  sessionId: 1,
  capabilityTags: 1,
});
