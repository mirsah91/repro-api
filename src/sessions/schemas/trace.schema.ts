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
}

export type TraceEvtDocument = HydratedDocument<TraceEvt>;
export const TraceEvtSchema = SchemaFactory.createForClass(TraceEvt);

TraceEvtSchema.index(
  { tenantId: 1, sessionId: 1, requestRid: 1, batchIndex: 1 },
  { unique: true },
);
TraceEvtSchema.index({ tenantId: 1, sessionId: 1, requestRid: 1 });
TraceEvtSchema.index({ tenantId: 1, sessionId: 1 });
