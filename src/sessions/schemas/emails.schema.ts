// modules/sessions/schemas/email-evt.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'emails' })
export class EmailEvt {
    @Prop({ type: String }) sessionId: string;
    @Prop({ type: String }) actionId: string | null;

    @Prop({ type: String }) provider: string;   // e.g. "sendgrid"
    @Prop({ type: String }) kind: string;       // "send" | "sendMultiple"

    @Prop({ type: Object }) from?: { email: string; name?: string } | null;
    @Prop({ type: Array, default: [] }) to: Array<{ email: string; name?: string }>;
    @Prop({ type: Array, default: [] }) cc: Array<{ email: string; name?: string }>;
    @Prop({ type: Array, default: [] }) bcc: Array<{ email: string; name?: string }>;

    @Prop({ type: String }) subject?: string;
    @Prop({ type: String }) text?: string | null;
    @Prop({ type: String }) html?: string | null;

    @Prop({ type: String }) templateId?: string | null;
    @Prop({ type: Object }) dynamicTemplateData?: Record<string, any> | null;
    @Prop({ type: [String], default: [] }) categories?: string[];
    @Prop({ type: Object }) customArgs?: Record<string, any> | null;

    @Prop({ type: Array, default: [] })
    attachmentsMeta?: Array<{ filename?: string; type?: string; size?: number }>;

    @Prop({ type: Number }) statusCode?: number | null;
    @Prop({ type: Number }) durMs?: number | null;
    @Prop({ type: Object }) headers?: Record<string, any>;

    @Prop({ type: Number }) t: number;
}
export type EmailEvtDocument = HydratedDocument<EmailEvt>;
export const EmailEvtSchema = SchemaFactory.createForClass(EmailEvt);
