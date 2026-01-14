import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import { ContactRequestDto } from './dto/contact.dto';

const DEFAULT_FROM_NAME = 'Repro Contact';

@Injectable()
export class ContactService {
  private configured = false;

  constructor(private readonly config: ConfigService) {}

  async sendContactEmail(payload: ContactRequestDto): Promise<void> {
    this.ensureClient();
    const settings = this.resolveSettings();
    const fullName = `${payload.name} ${payload.suername}`.trim();

    try {
      const msg = {
        to: settings.toEmail,
        from: settings.fromEmail,
        subject: `New contact request from ${fullName || payload.email}`,
        text: this.buildText(payload),
        html: this.buildHtml(payload),
      }
      await sgMail.send(msg);
    } catch (err: unknown) {
      throw new InternalServerErrorException('Failed to send contact message');
    }
  }

  private ensureClient(): void {
    if (this.configured) {
      return;
    }
    const apiKey = this.config.get<string>('SENDGRID_API_KEY')?.trim();
    if (!apiKey) {
      throw new InternalServerErrorException(
        'SENDGRID_API_KEY must be configured',
      );
    }
    sgMail.setApiKey(apiKey);

    this.configured = true;
  }

  private resolveSettings(): {
    fromEmail: string;
    fromName: string;
    toEmail: string;
    toName: string;
  } {
    const fromEmail = this.config.get<string>('SENDGRID_FROM_EMAIL')?.trim();
    const fromName =
      this.config.get<string>('SENDGRID_FROM_NAME')?.trim() ||
      DEFAULT_FROM_NAME;
    const toEmail = this.config.get<string>('SENDGRID_TO_EMAIL')?.trim();
    const toName = this.config.get<string>('SENDGRID_TO_NAME')?.trim() || 'Team';

    if (!fromEmail || !toEmail) {
      throw new InternalServerErrorException(
        'SENDGRID_FROM_EMAIL and SENDGRID_TO_EMAIL must be configured',
      );
    }

    return { fromEmail, fromName, toEmail, toName };
  }

  private buildText(payload: ContactRequestDto): string {
    return [
      'New contact request',
      '',
      `Name: ${payload.name}`,
      `Surname: ${payload.suername}`,
      `Email: ${payload.email}`,
      '',
      'Message:',
      payload.message,
    ].join('\n');
  }

  private buildHtml(payload: ContactRequestDto): string {
    const escape = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    return [
      '<h2>New contact request</h2>',
      `<p><strong>Name:</strong> ${escape(payload.name)}</p>`,
      `<p><strong>Surname:</strong> ${escape(payload.suername)}</p>`,
      `<p><strong>Email:</strong> ${escape(payload.email)}</p>`,
      '<p><strong>Message:</strong></p>',
      `<pre>${escape(payload.message)}</pre>`,
    ].join('');
  }
}
