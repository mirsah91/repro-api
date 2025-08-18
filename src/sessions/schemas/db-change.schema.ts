import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'db_changes' })
export class DbChange {
    @Prop() sessionId: string;
    @Prop() actionId: string;
    @Prop() collection: string;
    @Prop({ type: Object }) pk: Record<string, any>;
    @Prop({ type: Object }) before?: Record<string, any> | null;
    @Prop({ type: Object }) after?: Record<string, any> | null;
    @Prop() op: 'insert' | 'update' | 'delete';
    @Prop() t: number;
}
export type DbChangeDocument = HydratedDocument<DbChange>;
export const DbChangeSchema = SchemaFactory.createForClass(DbChange);
