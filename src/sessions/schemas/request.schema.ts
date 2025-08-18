import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
}
export type RequestEvtDocument = HydratedDocument<RequestEvt>;
export const RequestEvtSchema = SchemaFactory.createForClass(RequestEvt);
