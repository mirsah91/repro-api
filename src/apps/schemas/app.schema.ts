import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'apps' })
export class App {
  @Prop({ unique: true }) appId: string;
  @Prop() name: string;
  @Prop() appSecret: string;
  @Prop({ default: true }) enabled: boolean;
  @Prop() adminEmail?: string;
}
export type AppDocument = HydratedDocument<App>;
export const AppSchema = SchemaFactory.createForClass(App);
