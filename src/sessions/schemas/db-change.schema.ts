import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ collection: 'changes' })
export class DbChange {
  @Prop({ index: true }) tenantId: string;
  @Prop() sessionId: string;
  @Prop() actionId: string;

  @Prop() collection: string;
  @Prop() op: string; // 'find', 'updateOne', 'insert', 'deleteOne', 'aggregate', 'bulkWrite', ...

  // For document diffs (existing)
  @Prop({ type: SchemaTypes.Mixed }) pk?: any;
  @Prop({ type: SchemaTypes.Mixed }) before?: any;
  @Prop({ type: SchemaTypes.Mixed }) after?: any;

  // NEW for generic query capture
  @Prop({ type: SchemaTypes.Mixed }) query?: {
    filter?: any;
    update?: any;
    projection?: any;
    options?: any;
    pipeline?: any[];
    bulk?: any[];
  };

  @Prop({ type: SchemaTypes.Mixed }) resultMeta?: {
    docsCount?: number;
    matched?: number;
    modified?: number;
    upsertedId?: any;
    upserted?: number;
    deleted?: number;
    result?: any;
  };

  @Prop() durMs?: number;
  @Prop({ type: SchemaTypes.Mixed }) error?: { message?: string; code?: any };

  @Prop() t: number;
}

export type DbChangeDocument = HydratedDocument<DbChange>;
export const DbChangeSchema = SchemaFactory.createForClass(DbChange);
