import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'sdk_tokens' })
export class SdkToken {
  @Prop() appId: string;
  @Prop() token: string;
  @Prop() exp: Date;
}
export type SdkTokenDocument = HydratedDocument<SdkToken>;
export const SdkTokenSchema = SchemaFactory.createForClass(SdkToken);
