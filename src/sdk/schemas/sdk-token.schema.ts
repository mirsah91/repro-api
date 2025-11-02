import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'sdk_tokens' })
export class SdkToken {
  @Prop({ index: true }) tenantId: string;
  @Prop() appId: string;
  @Prop() tokenHash: string;
  @Prop() tokenEnc: string;
  @Prop() exp: Date;
}
export type SdkTokenDocument = HydratedDocument<SdkToken>;
export const SdkTokenSchema = SchemaFactory.createForClass(SdkToken);

SdkTokenSchema.index({ tenantId: 1, tokenHash: 1 }, { unique: true });
