import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import * as sgMail from '@sendgrid/mail';
import { AppUser, AppUserDocument } from './schemas/app-user.schema';
import { App, AppDocument } from './schemas/app.schema';
import {
  AppUserPasswordReset,
  AppUserPasswordResetDocument,
} from './schemas/app-user-password-reset.schema';
import { encryptString, hashSecret } from '../common/security/encryption.util';

const DEFAULT_RESET_TTL_MINUTES = 60;
const DEFAULT_RESET_PATH = '/reset-password';
const DEFAULT_FROM_NAME = 'Repro';

@Injectable()
export class AppUserPasswordResetService {
  private configured = false;

  constructor(
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
    @InjectModel(App.name) private readonly apps: Model<AppDocument>,
    @InjectModel(AppUserPasswordReset.name)
    private readonly resets: Model<AppUserPasswordResetDocument>,
    private readonly config: ConfigService,
  ) {}

  async requestReset(appId: string, email: string): Promise<void> {
    const normalizedAppId = this.normalizeValue(appId);
    const normalizedEmail = this.normalizeEmail(email);

    if (!normalizedAppId || !normalizedEmail) {
      throw new BadRequestException('appId and email are required');
    }

    const user = await this.users
      .findOne({
        appId: normalizedAppId,
        email: normalizedEmail,
        enabled: true,
      })
      .lean<{
        _id: AppUserDocument['_id'];
        tenantId: string;
        appId: string;
        email: string;
        name?: string;
      } | null>();

    if (!user) {
      return;
    }

    const token = this.generateToken();
    const expiresAt = this.buildExpiry();

    await this.resets.deleteMany({ appId: normalizedAppId, userId: user._id });
    await this.resets.create({
      tenantId: user.tenantId,
      appId: normalizedAppId,
      userId: user._id,
      email: user.email,
      tokenHash: hashSecret(token),
      expiresAt,
      usedAt: null,
    });

    const resetUrl = this.buildResetUrl(normalizedAppId, token);
    const appName = await this.resolveAppName(normalizedAppId);
    await this.sendResetEmail({
      toEmail: user.email,
      toName: user.name ?? user.email,
      resetUrl,
      appName,
    });
  }

  async resetPassword(
    appId: string,
    token: string,
    newPassword: string,
  ): Promise<void> {
    const normalizedAppId = this.normalizeValue(appId);
    const normalizedToken = this.normalizeValue(token);
    const normalizedPassword = this.normalizeValue(newPassword);

    if (!normalizedAppId || !normalizedToken || !normalizedPassword) {
      throw new BadRequestException('appId, token, and newPassword are required');
    }

    const now = new Date();
    const tokenHash = hashSecret(normalizedToken);
    const resetDoc = await this.resets
      .findOne({
        appId: normalizedAppId,
        tokenHash,
        usedAt: null,
        expiresAt: { $gt: now },
      })
      .lean<AppUserPasswordResetDocument | null>();

    if (!resetDoc) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const user = await this.users.findOne({
      _id: resetDoc.userId,
      appId: normalizedAppId,
      enabled: true,
    });
    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    user.tokenHash = hashSecret(normalizedPassword);
    user.tokenEnc = encryptString(normalizedPassword);
    await user.save();

    await this.resets.updateOne(
      { _id: resetDoc._id },
      { $set: { usedAt: now } },
    );
    await this.resets.deleteMany({
      appId: normalizedAppId,
      userId: resetDoc.userId,
      _id: { $ne: resetDoc._id },
    });
  }

  private ensureMailer(): void {
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

  private resolveSender(): { email: string; name: string } {
    const email = this.config.get<string>('SENDGRID_FROM_EMAIL')?.trim();
    const name =
      this.config.get<string>('SENDGRID_FROM_NAME')?.trim() ||
      DEFAULT_FROM_NAME;
    if (!email) {
      throw new InternalServerErrorException(
        'SENDGRID_FROM_EMAIL must be configured',
      );
    }
    return { email, name };
  }

  private async sendResetEmail(params: {
    toEmail: string;
    toName: string;
    resetUrl: string;
    appName?: string;
  }): Promise<void> {
    this.ensureMailer();
    const sender = this.resolveSender();
    const ttlMinutes = this.getResetTtlMinutes();
    const subject = params.appName
      ? `Reset your ${params.appName} password`
      : 'Reset your password';

    try {
      await sgMail.send({
        to: { email: params.toEmail, name: params.toName },
        from: sender,
        subject,
        text: this.buildText({
          resetUrl: params.resetUrl,
          ttlMinutes,
          appName: params.appName,
        }),
        html: this.buildHtml({
          resetUrl: params.resetUrl,
          ttlMinutes,
          appName: params.appName,
        }),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        'Failed to send password reset email',
      );
    }
  }

  private buildResetUrl(appId: string, token: string): string {
    const explicit = this.config.get<string>('APP_USER_RESET_URL')?.trim();
    const baseUrl =
      explicit ||
      this.config.get<string>('APP_URL')?.trim() ||
      'https://repro.app';
    const path =
      explicit ||
      this.config.get<string>('APP_USER_RESET_PATH')?.trim() ||
      DEFAULT_RESET_PATH;

    const url = explicit ? new URL(baseUrl) : new URL(path, baseUrl);
    url.searchParams.set('appId', appId);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private buildText(params: {
    resetUrl: string;
    ttlMinutes: number;
    appName?: string;
  }): string {
    const appLabel = params.appName || 'your workspace';
    return [
      `We received a request to reset the password for ${appLabel}.`,
      '',
      `Use the link below to choose a new password (expires in ${params.ttlMinutes} minutes):`,
      params.resetUrl,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n');
  }

  private buildHtml(params: {
    resetUrl: string;
    ttlMinutes: number;
    appName?: string;
  }): string {
    const appLabel = params.appName || 'your workspace';
    return [
      `<p>We received a request to reset the password for ${this.escape(
        appLabel,
      )}.</p>`,
      `<p>Use the link below to choose a new password (expires in ${params.ttlMinutes} minutes):</p>`,
      `<p><a href="${this.escape(params.resetUrl)}">Reset password</a></p>`,
      `<p>If you did not request this, you can safely ignore this email.</p>`,
    ].join('');
  }

  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private normalizeEmail(value: string): string {
    return this.normalizeValue(value).toLowerCase();
  }

  private normalizeValue(value: string): string {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  private buildExpiry(): Date {
    const ttlMinutes = this.getResetTtlMinutes();
    return new Date(Date.now() + ttlMinutes * 60 * 1000);
  }

  private getResetTtlMinutes(): number {
    const raw = this.config
      .get<string>('APP_USER_RESET_TOKEN_TTL_MINUTES')
      ?.trim();
    if (!raw) {
      return DEFAULT_RESET_TTL_MINUTES;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_RESET_TTL_MINUTES;
    }
    return Math.floor(parsed);
  }

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private async resolveAppName(appId: string): Promise<string | undefined> {
    const app = await this.apps
      .findOne({ appId })
      .lean<{ name?: string } | null>();
    return app?.name;
  }
}
