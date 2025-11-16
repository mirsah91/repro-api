import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { RequestEvt } from './request.schema';

@Schema({ collection: 'traces' })
export class TraceEvt {
  @Prop({ index: true })
  tenantId!: string;

  @Prop({ required: true })
  sessionId!: string;

  @Prop({ required: true })
  requestRid!: string;

  @Prop({ required: true })
  batchIndex!: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: RequestEvt.name })
  request?: Types.ObjectId;

  @Prop({ type: SchemaTypes.Mixed })
  data?: any;

  @Prop({
    type: [
      {
        file: { type: String },
        line: { type: Number },
        fn: { type: String },
        argsPreview: { type: String },
        resultPreview: { type: String },
        durationMs: { type: Number },
        metadata: { type: SchemaTypes.Mixed },
      },
    ],
  })
  codeRefs?: Array<{
    file?: string | null;
    line?: number | null;
    fn?: string | null;
    argsPreview?: string | null;
    resultPreview?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, any> | null;
  }>;
}

export type TraceEvtDocument = HydratedDocument<TraceEvt>;
export const TraceEvtSchema = SchemaFactory.createForClass(TraceEvt);

TraceEvtSchema.index(
  { tenantId: 1, sessionId: 1, requestRid: 1, batchIndex: 1 },
  { unique: true },
);
TraceEvtSchema.index({ tenantId: 1, sessionId: 1, requestRid: 1 });
TraceEvtSchema.index({ tenantId: 1, sessionId: 1 });
