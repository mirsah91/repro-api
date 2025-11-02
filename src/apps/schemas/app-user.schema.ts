import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum AppUserRole {
  Admin = 'admin',
  Viewer = 'viewer',
  Recorder = 'recorder',
}

@Schema({ timestamps: true, collection: 'app_users' })
export class AppUser {
  @Prop({ index: true }) tenantId!: string;
  @Prop({ index: true }) appId!: string;

  @Prop({ required: true })
  email!: string;

  @Prop({ enum: AppUserRole, default: AppUserRole.Viewer })
  role!: AppUserRole;

  @Prop({ required: true }) tokenHash!: string;
  @Prop({ required: true }) tokenEnc!: string;

  @Prop({ default: true })
  enabled!: boolean;

  @Prop()
  name?: string;
}

export type AppUserDocument = HydratedDocument<AppUser>;
export const AppUserSchema = SchemaFactory.createForClass(AppUser);

AppUserSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, name: 'uniq_tenant_email' },
);
AppUserSchema.index(
  { tenantId: 1, appId: 1, tokenHash: 1 },
  { unique: true, name: 'uniq_app_token' },
);
