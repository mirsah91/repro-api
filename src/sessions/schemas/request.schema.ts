import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ collection: 'requests' })
export class RequestEvt {
  @Prop({ index: true }) tenantId: string;
  @Prop() sessionId: string;
  @Prop() actionId: string;
  @Prop() rid: string;
  @Prop() method: string;
  @Prop() url: string;
  @Prop() status: number;
  @Prop() durMs: number;
  @Prop() t: number;
  @Prop({ type: SchemaTypes.Mixed }) headers?: Record<string, any>;
  @Prop() key?: string; // normalized endpoint key
  @Prop({ type: SchemaTypes.Mixed }) respBody?: any; // captured JSON response (truncated if needed)
  @Prop({ type: SchemaTypes.Mixed }) body?: any; // captured request payload
  @Prop({ type: SchemaTypes.Mixed }) params?: Record<string, any>; // route params
  @Prop({ type: SchemaTypes.Mixed }) query?: Record<string, any>; // query string params
  @Prop({
    type: {
      fn: { type: String },
      file: { type: String },
      line: { type: Number },
      functionType: { type: String },
      _id: { type: SchemaTypes.Mixed },
    },
  })
  entryPoint?: {
    fn?: string | null;
    file?: string | null;
    line?: number | null;
    functionType?: string | null;
    _id?: any;
  };
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

export type RequestEvtDocument = HydratedDocument<RequestEvt>;
export const RequestEvtSchema = SchemaFactory.createForClass(RequestEvt);

RequestEvtSchema.index({ tenantId: 1, sessionId: 1, t: 1 });
RequestEvtSchema.index({ tenantId: 1, sessionId: 1, key: 1, t: 1 });
RequestEvtSchema.index({
  tenantId: 1,
  sessionId: 1,
  'entryPoint.fn': 1,
  t: 1,
});
