import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'trace_nodes',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
})
export class TraceNode {
  @Prop({ type: String, index: true })
  tenantId!: string;

  @Prop({ type: String, required: true })
  sessionId!: string;

  @Prop({ type: String, required: true, index: true })
  chunkId!: string;

  @Prop({ type: String, index: true })
  groupId!: string;

  @Prop({ type: String })
  requestRid?: string | null;

  @Prop({ type: String })
  actionId?: string | null;

  @Prop({ type: Number })
  batchIndex?: number | null;

  @Prop({ type: String, index: true })
  parentChunkId?: string | null;

  @Prop({ type: [String], default: [] })
  childChunkIds?: string[];

  @Prop({ type: String })
  functionName?: string | null;

  @Prop({ type: String })
  filePath?: string | null;

  @Prop({ type: Number })
  lineNumber?: number | null;

  @Prop({ type: Number })
  depth?: number | null;

  @Prop({ type: String })
  argsPreview?: string | null;

  @Prop({ type: String })
  resultPreview?: string | null;

  @Prop({ type: Number })
  durationMs?: number | null;

  @Prop({ type: Number })
  eventStart?: number | null;

  @Prop({ type: Number })
  eventEnd?: number | null;

  @Prop({ type: Array })
  sampleEvents?: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;

  @Prop({ type: Array })
  metadata?: Array<{ key: string; value: string }>;
}

export type TraceNodeDocument = HydratedDocument<TraceNode>;
export const TraceNodeSchema = SchemaFactory.createForClass(TraceNode);

TraceNodeSchema.index(
  { tenantId: 1, sessionId: 1, chunkId: 1 },
  { unique: true },
);
TraceNodeSchema.index({ tenantId: 1, sessionId: 1, parentChunkId: 1 });
TraceNodeSchema.index({ tenantId: 1, sessionId: 1, functionName: 1 });
