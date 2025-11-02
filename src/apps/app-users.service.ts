import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from './schemas/app-user.schema';
import { App, AppDocument } from './schemas/app.schema';
import {
  decryptString,
  encryptString,
  hashSecret,
} from '../common/security/encryption.util';
import { TenantContext } from '../common/tenant/tenant-context';

type StoredAppUser = {
  _id: AppUserDocument['_id'];
  tenantId: string;
  appId: string;
  email: string;
  role: AppUserRole;
  tokenHash: string;
  tokenEnc: string;
  enabled: boolean;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface AppUserDtoShape {
  id: string;
  tenantId: string;
  appId: string;
  email: string;
  role: AppUserRole;
  password?: string;
  enabled: boolean;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AppSummaryShape {
  tenantId: string;
  appId: string;
  name: string;
  enabled: boolean;
  adminEmail?: string;
  createdAt?: Date;
  updatedAt?: Date;
  appSecret?: string;
}

@Injectable()
export class AppUsersService {
  private legacyIndexCleanup?: Promise<void>;

  constructor(
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
    @InjectModel(App.name) private readonly apps: Model<AppDocument>,
    private readonly tenant: TenantContext,
  ) {}

  async list(appId: string): Promise<AppUserDtoShape[]> {
    const docs = await this.users
      .find(this.withTenantFilter({ appId }))
      .sort({ createdAt: -1 })
      .lean<StoredAppUser[]>();
    return docs.map((doc) => this.toDto(doc));
  }

  async create(
    appId: string,
    dto: {
      email: string;
      role?: AppUserRole;
      name?: string;
      enabled?: boolean;
    },
  ): Promise<AppUserDtoShape> {
    const email = this.normalizeEmail(dto.email);
    const password = randomUUID();
    const role = dto.role ?? AppUserRole.Viewer;
    const enabled = dto.enabled ?? true;
    const name = typeof dto.name === 'string' ? dto.name.trim() : undefined;

    try {
      const created = await this.users.create({
        tenantId: this.tenant.tenantId,
        appId,
        email,
        role,
        tokenHash: hashSecret(password),
        tokenEnc: encryptString(password),
        name,
        enabled,
      });
      return this.toDto(created.toObject() as unknown as StoredAppUser, password);
    } catch (err) {
      if (this.isLegacyTokenIndexError(err)) {
        await this.ensureLegacyTokenIndexDropped();
        return this.create(appId, dto);
      }
      this.handleDuplicateEmailError(err);
    }
  }

  async find(appId: string, userId: string): Promise<AppUserDtoShape> {
    const doc = await this.users
      .findOne(this.withTenantFilter({ appId, _id: userId }))
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('User not found');
    return this.toDto(doc);
  }

  async canRecord(
    appId: string,
    email: string,
    password: string,
  ): Promise<AppUserDtoShape> {
    return this.validateCredentials(appId, email, password);
  }

  async login(
    appId: string,
    email: string,
    password: string,
  ): Promise<AppUserDtoShape> {
    try {
      const { user } = await this.loginByCredentials(email, password);
      if (user.appId !== appId) {
        throw new NotFoundException('Invalid credentials');
      }
      return user;
    } catch (error) {
      console.log('error ==>', error)
      return null as any
    }
  }

  async loginByCredentials(
    email: string,
    password: string,
  ): Promise<{ user: AppUserDtoShape; app: AppSummaryShape }> {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedPassword = password.trim();
    const doc = await this.users
      .findOne({
        tenantId: this.tenant.tenantId,
        email: normalizedEmail,
        tokenHash: hashSecret(normalizedPassword),
        enabled: true,
      })
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('Invalid credentials');

    const user = this.toDto(doc, normalizedPassword);
    const appDoc = await this.apps
      .findOne(this.withTenantFilter({ appId: user.appId }))
      .lean<{
        appId: string;
        tenantId: string;
        name?: string;
        enabled?: boolean;
        adminEmail?: string;
        createdAt?: Date;
        updatedAt?: Date;
        appSecretEnc?: string;
      } | null>();
    const app = appDoc
      ? this.toAppDto(appDoc, user.role === AppUserRole.Admin)
      : this.toFallbackApp(user.appId);
    return { user, app };
  }

  async loginWithoutTenant(
    email: string,
    password: string,
  ): Promise<{ user: AppUserDtoShape; app: AppSummaryShape }> {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedPassword = password.trim();

    const doc = await this.users
      .findOne({
        email: normalizedEmail,
        tokenHash: hashSecret(normalizedPassword),
        enabled: true,
      })
      .lean<StoredAppUser | null>();

    if (!doc) throw new NotFoundException('Invalid credentials');

    this.tenant.setTenantId(doc.tenantId);
    const user = this.toDto(doc, normalizedPassword);

    const appDoc = await this.apps
      .findOne({ tenantId: doc.tenantId, appId: doc.appId })
      .lean<{
        tenantId: string;
        appId: string;
        name?: string;
        enabled?: boolean;
        adminEmail?: string;
        createdAt?: Date;
        updatedAt?: Date;
        appSecretEnc?: string;
      } | null>();

    const app = appDoc
      ? this.toAppDto(appDoc, user.role === AppUserRole.Admin)
      : this.toFallbackApp(user.appId);

    return { user, app };
  }

  async updateProfile(
    appId: string,
    userId: string,
    dto: { email?: string; name?: string | null },
  ): Promise<AppUserDtoShape> {
    const doc = await this.users.findOne(
      this.withTenantFilter({ appId, _id: userId }),
    );
    if (!doc) throw new NotFoundException('User not found');

    if (typeof dto.email !== 'undefined') {
      doc.email = this.normalizeEmail(dto.email);
    }

    if (typeof dto.name !== 'undefined') {
      const trimmed = typeof dto.name === 'string' ? dto.name.trim() : undefined;
      doc.name = trimmed ?? undefined;
    }

    try {
      await doc.save();
    } catch (err) {
      if (this.isLegacyTokenIndexError(err)) {
        await this.ensureLegacyTokenIndexDropped();
        return this.update(appId, userId, dto);
      }
      this.handleDuplicateEmailError(err);
    }

    return this.toDto(doc.toObject() as unknown as StoredAppUser);
  }

  async update(
    appId: string,
    userId: string,
    dto: {
      role?: AppUserRole;
      name?: string | null;
      enabled?: boolean;
      resetPassword?: boolean;
    },
  ): Promise<AppUserDtoShape> {
    const doc = await this.users.findOne(
      this.withTenantFilter({ appId, _id: userId }),
    );
    if (!doc) throw new NotFoundException('User not found');

    if (typeof dto.role !== 'undefined') doc.role = dto.role;
    if (typeof dto.enabled !== 'undefined') doc.enabled = dto.enabled;
    if (typeof dto.name !== 'undefined') {
      const trimmed =
        typeof dto.name === 'string' ? dto.name.trim() : undefined;
      doc.name = trimmed ?? undefined;
    }

    if (dto.resetPassword) {
      const newPassword = randomUUID();
      doc.tokenHash = hashSecret(newPassword);
      doc.tokenEnc = encryptString(newPassword);
      await doc.save();
      return this.toDto(
        doc.toObject() as unknown as StoredAppUser,
        newPassword,
      );
    }

    try {
      await doc.save();
    } catch (err) {
      this.handleDuplicateEmailError(err);
    }
    return this.toDto(doc.toObject() as unknown as StoredAppUser);
  }

  async remove(appId: string, userId: string): Promise<{ deleted: boolean }> {
    const res = await this.users.deleteOne(
      this.withTenantFilter({ appId, _id: userId }),
    );
    if (!res.deletedCount) throw new NotFoundException('User not found');
    return { deleted: true };
  }

  private toDto(
    doc: StoredAppUser,
    passwordOverride?: string,
  ): AppUserDtoShape {
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

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private async validateCredentials(
    appId: string,
    email: string,
    password: string,
  ): Promise<AppUserDtoShape> {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedPassword = password.trim();
    const doc = await this.users
      .findOne({
        tenantId: this.tenant.tenantId,
        appId,
        email: normalizedEmail,
        tokenHash: hashSecret(normalizedPassword),
        enabled: true,
      })
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('Invalid credentials');
    return this.toDto(doc);
  }

  private isLegacyTokenIndexError(err: unknown): boolean {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    ) {
      const pattern = (err as any).keyPattern;
      if (pattern && typeof pattern === 'object' && 'token' in pattern) {
        return true;
      }
    }
    return false;
  }

  private async ensureLegacyTokenIndexDropped() {
    if (!this.legacyIndexCleanup) {
      this.legacyIndexCleanup = (async () => {
        const collection = this.users.collection;
        const indexes = await collection.indexes();
        const legacy = indexes.find(
          (idx) => idx.name === 'uniq_app_token' && idx.key?.token !== undefined,
        );
        if (legacy) {
          const dropTarget = legacy.name ?? legacy.key;
          await collection.dropIndex(dropTarget as any);
          await this.users.syncIndexes();
        }
      })().catch((err) => {
        this.legacyIndexCleanup = undefined;
        throw err;
      });
    }
    await this.legacyIndexCleanup;
  }

  private toAppDto(
    doc: {
      tenantId: string;
      appId: string;
      name?: string;
      enabled?: boolean;
      adminEmail?: string;
      createdAt?: Date;
      updatedAt?: Date;
      appSecretEnc?: string;
    },
    includeSecret: boolean,
  ): AppSummaryShape {
    const base: AppSummaryShape = {
      tenantId: doc.tenantId,
      appId: doc.appId,
      name: doc.name ?? doc.appId,
      enabled: typeof doc.enabled === 'boolean' ? doc.enabled : true,
      adminEmail: doc.adminEmail,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (includeSecret) {
      return {
        ...base,
        appSecret: doc.appSecretEnc ? safeDecrypt(doc.appSecretEnc) : undefined,
      };
    }
    return base;
  }

  private toFallbackApp(appId: string): AppSummaryShape {
    return {
      tenantId: this.tenant.tenantId,
      appId,
      name: appId,
      enabled: true,
    };
  }

  private handleDuplicateEmailError(err: unknown): never {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: number }).code;
      if (code === 11000) {
        throw new ConflictException('Email is already in use');
      }
    }
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(typeof err === 'string' ? err : 'Unknown error');
  }

  private withTenantFilter<T extends Record<string, any>>(base: T): T & {
    tenantId: string;
  } {
    return { ...base, tenantId: this.tenant.tenantId };
  }
}

function safeDecrypt(payload: string): string | undefined {
  try {
    return decryptString(payload);
  } catch {
    return undefined;
  }
}
