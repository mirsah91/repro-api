import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'session_graph_edges',
  _id: false,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
})
export class SessionGraphEdge {
  @Prop({ type: String })
  _id!: string;

  @Prop({ index: true })
  tenantId!: string;

  @Prop({ index: true, required: true })
  sessionId!: string;

  @Prop({ required: true })
  fromNodeId!: string;

  @Prop({ required: true })
  toNodeId!: string;

  @Prop()
  relation?: string;

  @Prop()
  weight?: number;
}

export type SessionGraphEdgeDocument = HydratedDocument<SessionGraphEdge>;
export const SessionGraphEdgeSchema =
  SchemaFactory.createForClass(SessionGraphEdge);

SessionGraphEdgeSchema.index({
  tenantId: 1,
  sessionId: 1,
  fromNodeId: 1,
});
SessionGraphEdgeSchema.index({
  tenantId: 1,
  sessionId: 1,
  toNodeId: 1,
});
