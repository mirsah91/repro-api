import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'changes' })
export class DbChange {
  @Prop() sessionId: string;
  @Prop() actionId: string;

  @Prop() collection: string;
  @Prop() op: string; // 'find', 'updateOne', 'insert', 'deleteOne', 'aggregate', 'bulkWrite', ...

  // For document diffs (existing)
  @Prop({ type: Object }) pk?: any;
  @Prop({ type: Object }) before?: any;
  @Prop({ type: Object }) after?: any;

  // NEW for generic query capture
  @Prop({ type: Object }) query?: {
    filter?: any;
    update?: any;
    projection?: any;
    options?: any;
    pipeline?: any[];
    bulk?: any[];
  };

  @Prop({ type: Object }) resultMeta?: {
    docsCount?: number;
    matched?: number;
    modified?: number;
    upsertedId?: any;
    upserted?: number;
    deleted?: number;
    result?: any;
  };

  @Prop() durMs?: number;
  @Prop({ type: Object }) error?: { message?: string; code?: any };

  @Prop() t: number;
}

export type DbChangeDocument = HydratedDocument<DbChange>;
export const DbChangeSchema = SchemaFactory.createForClass(DbChange);
