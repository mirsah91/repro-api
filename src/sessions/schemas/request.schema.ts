import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ collection: 'requests' })
export class RequestEvt {
    @Prop() sessionId: string;
    @Prop() actionId: string;
    @Prop() rid: string;
    @Prop() method: string;
    @Prop() url: string;
    @Prop() status: number;
    @Prop() durMs: number;
    @Prop() t: number;
    @Prop({ type: Object }) headers?: Record<string, any>;
    @Prop() key?: string;                          // normalized endpoint key
    @Prop({ type: SchemaTypes.Mixed }) respBody?: any; // captured JSON response (truncated if needed)
    @Prop({ type: Object }) trace: Record<string, any>;
}

export type RequestEvtDocument = HydratedDocument<RequestEvt>;
export const RequestEvtSchema = SchemaFactory.createForClass(RequestEvt);

RequestEvtSchema.index({ sessionId: 1, t: 1 });
RequestEvtSchema.index({ sessionId: 1, key: 1, t: 1 });