import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'trace_summaries',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
})
export class TraceSummary {
  @Prop({ type: String, index: true })
  tenantId!: string;

  @Prop({ type: String, required: true })
  sessionId!: string;

  @Prop({ type: String, required: true })
  groupId!: string;

  @Prop({ type: String })
  requestRid?: string | null;

  @Prop({ type: String })
  actionId?: string | null;

  @Prop({ type: Number, required: true })
  segmentIndex!: number;

  @Prop({ type: Number, required: true })
  eventStart!: number;

  @Prop({ type: Number, required: true })
  eventEnd!: number;

  @Prop({ type: Number, required: true })
  eventCount!: number;

  @Prop({ type: String, required: true })
  summary!: string;

  @Prop({ type: String, required: true })
  segmentHash!: string;

  @Prop({ type: String, required: true })
  model!: string;

  @Prop({ type: String })
  traceId?: string | null;

  @Prop({ type: Array })
  previewEvents?: Array<{
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    type?: string | null;
  }>;
}

export type TraceSummaryDocument = HydratedDocument<TraceSummary>;
export const TraceSummarySchema = SchemaFactory.createForClass(TraceSummary);

TraceSummarySchema.index(
  { tenantId: 1, sessionId: 1, groupId: 1, segmentIndex: 1 },
  { unique: true },
);
