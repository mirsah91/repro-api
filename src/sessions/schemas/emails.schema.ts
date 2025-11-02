// modules/sessions/schemas/email-evt.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ collection: 'emails' })
export class EmailEvt {
  @Prop({ index: true }) tenantId: string;
  @Prop({ type: String }) sessionId: string;
  @Prop({ type: String }) actionId: string | null;

  @Prop({ type: String }) provider: string; // e.g. "sendgrid"
  @Prop({ type: String }) kind: string; // "send" | "sendMultiple"

  @Prop({ type: SchemaTypes.Mixed }) from?: { email: string; name?: string } | null;
  @Prop({ type: SchemaTypes.Mixed }) to: Array<{
    email: string;
    name?: string;
  }>;
  @Prop({ type: SchemaTypes.Mixed }) cc: Array<{
    email: string;
    name?: string;
  }>;
  @Prop({ type: SchemaTypes.Mixed }) bcc: Array<{
    email: string;
    name?: string;
  }>;

  @Prop({ type: String }) subject?: string;
  @Prop({ type: String }) text?: string | null;
  @Prop({ type: String }) html?: string | null;

  @Prop({ type: String }) templateId?: string | null;
  @Prop({ type: SchemaTypes.Mixed }) dynamicTemplateData?: Record<string, any> | null;
  @Prop({ type: SchemaTypes.Mixed }) categories?: string[];
  @Prop({ type: SchemaTypes.Mixed }) customArgs?: Record<string, any> | null;

  @Prop({ type: SchemaTypes.Mixed })
  attachmentsMeta?: Array<{ filename?: string; type?: string; size?: number }>;

  @Prop({ type: Number }) statusCode?: number | null;
  @Prop({ type: Number }) durMs?: number | null;
  @Prop({ type: SchemaTypes.Mixed }) headers?: Record<string, any>;

  @Prop({ type: Number }) t: number;
}
export type EmailEvtDocument = HydratedDocument<EmailEvt>;
export const EmailEvtSchema = SchemaFactory.createForClass(EmailEvt);
