import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'sessions', _id: false })
export class Session {
    @Prop({ type: String }) _id: string;           // sessionId
    @Prop() appId: string;
    @Prop() startedAt: Date;
    @Prop() finishedAt?: Date;
    @Prop({ type: Object }) env?: Record<string, any>;
    @Prop() notes?: string;
    @Prop() userId?: string;
    @Prop() userEmail?: string;
}
export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
