import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AppUser } from './app-user.schema';

@Schema({ timestamps: true, collection: 'app_user_password_resets' })
export class AppUserPasswordReset {
  @Prop({ index: true })
  tenantId!: string;

  @Prop({ index: true })
  appId!: string;

  @Prop({ type: Types.ObjectId, ref: AppUser.name, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  email!: string;

  @Prop({ required: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  usedAt?: Date | null;
}

export type AppUserPasswordResetDocument = HydratedDocument<AppUserPasswordReset>;
export const AppUserPasswordResetSchema =
  SchemaFactory.createForClass(AppUserPasswordReset);

AppUserPasswordResetSchema.index(
  { appId: 1, tokenHash: 1 },
  { unique: true, name: 'uniq_app_reset_token' },
);
AppUserPasswordResetSchema.index(
  { appId: 1, userId: 1 },
  { name: 'app_user_reset_by_user' },
);
AppUserPasswordResetSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_app_user_reset' },
);
