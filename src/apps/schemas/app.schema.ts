import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { APP_MAX_COUNT } from '../app-user.constants';

@Schema({ timestamps: true, collection: 'apps' })
export class App {
  @Prop({ unique: true }) tenantId: string;
  @Prop({ unique: true }) appId: string;
  @Prop() name: string;
  @Prop() appSecretHash: string;
  @Prop() appSecretEnc: string;
  @Prop({ required: true }) encryptionKeyEnc: string;
  @Prop({ default: true }) enabled: boolean;
  @Prop() adminEmail?: string;
  @Prop({ default: true }) chatEnabled?: boolean;
  @Prop({ default: 0 }) chatUsageCount?: number;
  @Prop({ type: Number, default: APP_MAX_COUNT })
  maxUserCount?: number;
}
export type AppDocument = HydratedDocument<App>;
export const AppSchema = SchemaFactory.createForClass(App);

AppSchema.index({ tenantId: 1 }, { unique: true, name: 'uniq_tenant' });
