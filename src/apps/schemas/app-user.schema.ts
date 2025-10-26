import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum AppUserRole {
  Admin = 'admin',
  Viewer = 'viewer',
  Recorder = 'recorder',
}

@Schema({ timestamps: true, collection: 'app_users' })
export class AppUser {
  @Prop({ index: true }) appId!: string;

  @Prop({ required: true, unique: true })
  email!: string;

  @Prop({ enum: AppUserRole, default: AppUserRole.Viewer })
  role!: AppUserRole;

  @Prop({ required: true })
  token!: string;

  @Prop({ default: true })
  enabled!: boolean;

  @Prop()
  name?: string;
}

export type AppUserDocument = HydratedDocument<AppUser>;
export const AppUserSchema = SchemaFactory.createForClass(AppUser);

AppUserSchema.index({ email: 1 }, { unique: true, name: 'uniq_email' });
AppUserSchema.index(
  { appId: 1, token: 1 },
  { unique: true, name: 'uniq_app_token' },
);
