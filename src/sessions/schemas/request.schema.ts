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
    type: [
      {
        file: { type: String },
        line: { type: Number },
        fn: { type: String },
      },
    ],
  })
  codeRefs?: Array<{
    file?: string | null;
    line?: number | null;
    fn?: string | null;
  }>;
}

export type RequestEvtDocument = HydratedDocument<RequestEvt>;
export const RequestEvtSchema = SchemaFactory.createForClass(RequestEvt);

RequestEvtSchema.index({ tenantId: 1, sessionId: 1, t: 1 });
RequestEvtSchema.index({ tenantId: 1, sessionId: 1, key: 1, t: 1 });
