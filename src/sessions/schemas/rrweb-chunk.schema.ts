import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import mongoose from 'mongoose';

@Schema({ collection: 'rrweb_chunks' })
export class RrwebChunk {
  @Prop({ index: true }) tenantId: string;
  @Prop() sessionId: string;
  @Prop() seq: number;
  @Prop() tFirst: number;
  @Prop() tLast: number;
  @Prop({ type: mongoose.Schema.Types.Buffer }) data: Buffer;
}
export type RrwebChunkDocument = HydratedDocument<RrwebChunk>;
export const RrwebChunkSchema = SchemaFactory.createForClass(RrwebChunk);
RrwebChunkSchema.index({ tenantId: 1, sessionId: 1, seq: 1 }, { unique: true });
