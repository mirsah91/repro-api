import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
}
export type AppDocument = HydratedDocument<App>;
export const AppSchema = SchemaFactory.createForClass(App);

AppSchema.index({ tenantId: 1 }, { unique: true, name: 'uniq_tenant' });
