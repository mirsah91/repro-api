import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'actions' })
export class Action {
    @Prop() sessionId: string;
    @Prop() actionId: string;
    @Prop() label?: string;
    @Prop() tStart?: number;
    @Prop() tEnd?: number;
    @Prop({ default: false }) hasReq: boolean;
    @Prop({ default: false }) hasDb: boolean;
    @Prop({ default: false }) error: boolean;
    @Prop({ type: Object }) ui?: Record<string, any>;
}
export type ActionDocument = HydratedDocument<Action>;
export const ActionSchema = SchemaFactory.createForClass(Action);

ActionSchema.index({ sessionId: 1, actionId: 1 },  { unique: true, name: 'uniq_session_action' });
