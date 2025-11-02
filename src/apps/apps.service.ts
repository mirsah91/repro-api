import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID, randomBytes } from 'crypto';
import { Model } from 'mongoose';
import { App, AppDocument } from './schemas/app.schema';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from './schemas/app-user.schema';
import {
  decryptString,
  encryptString,
  hashSecret,
} from '../common/security/encryption.util';
import { TenantContext } from '../common/tenant/tenant-context';

@Injectable()
export class AppsService {
  constructor(
    @InjectModel(App.name) private readonly model: Model<AppDocument>,
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
    private readonly tenant: TenantContext,
  ) {}

  async createApp(
    name: string | undefined,
    adminEmail: string,
    adminPassword?: string,
  ) {
    const tenantId = 'TENANT_' + randomUUID();
    const appId = 'APP_' + randomUUID();
    const appSecret = randomUUID();
    const normalizedEmail = adminEmail.trim().toLowerCase();
    const normalizedName = typeof name === 'string' ? name.trim() : undefined;
    const dataEncryptionKey = randomBytes(32).toString('base64');

    const createdApp = await this.model.create({
      tenantId,
      appId,
      appSecretHash: hashSecret(appSecret),
      appSecretEnc: encryptString(appSecret),
      encryptionKeyEnc: encryptString(dataEncryptionKey),
      name: normalizedName ?? appId,
      enabled: true,
      adminEmail: normalizedEmail,
    });

    const candidatePassword =
      typeof adminPassword === 'string' ? adminPassword.trim() : '';
    if (candidatePassword && candidatePassword.length < 12) {
      throw new BadRequestException(
        'Admin password must be at least 12 characters long.',
      );
    }

    const adminSecret =
      candidatePassword && candidatePassword.length >= 12
        ? candidatePassword
        : randomUUID();
    const adminUser = await this.users.create({
      tenantId,
      appId,
      email: normalizedEmail,
      role: AppUserRole.Admin,
      tokenHash: hashSecret(adminSecret),
      tokenEnc: encryptString(adminSecret),
      enabled: true,
    });

    return {
      tenantId,
      appId,
      appSecret,
      name: createdApp.name,
      enabled: createdApp.enabled,
      adminEmail: normalizedEmail,
      admin: this.toUserDto(adminUser.toObject(), adminSecret),
      encryptionKey: dataEncryptionKey,
    };
  }

  async listApps() {
    const apps = await this.model
      .find(this.withTenantFilter())
      .sort({ createdAt: -1 })
      .lean();
    return apps.map((app) => this.toAppDto(app));
  }

  async getApp(appId: string) {
    const app = await this.model.findOne(this.withTenantFilter({ appId })).lean();
    if (!app) throw new NotFoundException('App not found');
    return this.toAppDetailDto(app);
  }

  async updateApp(appId: string, update: { name?: string; enabled?: boolean }) {
    const app = await this.model.findOne(this.withTenantFilter({ appId }));
    if (!app) throw new NotFoundException('App not found');
    if (typeof update.name !== 'undefined') app.name = update.name;
    if (typeof update.enabled !== 'undefined') app.enabled = update.enabled;
    await app.save();
    return this.toAppDetailDto(app.toObject());
  }

  async removeApp(appId: string) {
    const res = await this.model.deleteOne(this.withTenantFilter({ appId }));
    if (!res.deletedCount) throw new NotFoundException('App not found');
    await this.users.deleteMany(this.withTenantFilter({ appId }));
    return { deleted: true };
  }

  private toAppDto(doc: any) {
    return {
      tenantId: doc.tenantId,
      appId: doc.appId,
      name: doc.name,
      enabled: doc.enabled,
      adminEmail: doc.adminEmail,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private toAppDetailDto(doc: any) {
    return {
      ...this.toAppDto(doc),
      appSecret:
        typeof doc.appSecretEnc === 'string'
          ? safeDecrypt(doc.appSecretEnc)
          : undefined,
      encryptionKey:
        typeof doc.encryptionKeyEnc === 'string'
          ? safeDecrypt(doc.encryptionKeyEnc)
          : undefined,
    };
  }

  private toUserDto(doc: any, passwordOverride?: string) {
    const password =
      passwordOverride ??
      (typeof doc.tokenEnc === 'string' ? safeDecrypt(doc.tokenEnc) : undefined);
    return {
      id: String(doc._id),
      tenantId: doc.tenantId,
      appId: doc.appId,
      email: doc.email,
      role: doc.role,
      password,
      enabled: doc.enabled,
      name: doc.name ?? undefined,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private withTenantFilter<T extends Record<string, any>>(
    base?: T,
  ): T & { tenantId?: string } {
    const tenantId = this.tenant.tryGetTenantId();
    return tenantId ? { ...(base ?? ({} as T)), tenantId } : base ?? ({} as T);
  }
}

function safeDecrypt(payload: string) {
  try {
    return decryptString(payload);
  } catch {
    return undefined;
  }
}
