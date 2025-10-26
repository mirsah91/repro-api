import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from './schemas/app-user.schema';
import { App, AppDocument } from './schemas/app.schema';

type StoredAppUser = {
  _id: AppUserDocument['_id'];
  appId: string;
  email: string;
  role: AppUserRole;
  token: string;
  enabled: boolean;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface AppUserDtoShape {
  id: string;
  appId: string;
  email: string;
  role: AppUserRole;
  token: string;
  enabled: boolean;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AppSummaryShape {
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
  constructor(
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
    @InjectModel(App.name) private readonly apps: Model<AppDocument>,
  ) {}

  async list(appId: string): Promise<AppUserDtoShape[]> {
    const docs = await this.users
      .find({ appId })
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
    const token = randomUUID();
    const role = dto.role ?? AppUserRole.Viewer;
    const enabled = dto.enabled ?? true;
    const name = typeof dto.name === 'string' ? dto.name.trim() : undefined;
    try {
      const created = await this.users.create({
        appId,
        email,
        role,
        token,
        name,
        enabled,
      });
      return this.toDto(created.toObject() as unknown as StoredAppUser);
    } catch (err) {
      this.handleDuplicateEmailError(err);
    }
  }

  async find(appId: string, userId: string): Promise<AppUserDtoShape> {
    const doc = await this.users
      .findOne({ appId, _id: userId })
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('User not found');
    return this.toDto(doc);
  }

  // TODO: hash token
  async canRecord(
    appId: string,
    email: string,
    token: string,
  ): Promise<AppUserDtoShape> {
    return this.validateCredentials(appId, email, token);
  }

  async login(
    appId: string,
    email: string,
    token: string,
  ): Promise<AppUserDtoShape> {
    const { user } = await this.loginByCredentials(email, token);
    if (user.appId !== appId) {
      throw new NotFoundException('Invalid credentials');
    }
    return user;
  }

  async loginByCredentials(
    email: string,
    token: string,
  ): Promise<{ user: AppUserDtoShape; app: AppSummaryShape }> {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedToken = token.trim();
    const doc = await this.users
      .findOne({
        email: normalizedEmail,
        token: normalizedToken,
        enabled: true,
      })
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('Invalid credentials');

    const user = this.toDto(doc);
    const appDoc = await this.apps
      .findOne({ appId: user.appId })
      .lean<{
        appId: string;
        name?: string;
        enabled?: boolean;
        adminEmail?: string;
        createdAt?: Date;
        updatedAt?: Date;
        appSecret?: string;
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
    const doc = await this.users.findOne({ appId, _id: userId });
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
      resetToken?: boolean;
    },
  ): Promise<AppUserDtoShape> {
    const doc = await this.users.findOne({ appId, _id: userId });
    if (!doc) throw new NotFoundException('User not found');

    if (typeof dto.role !== 'undefined') doc.role = dto.role;
    if (typeof dto.enabled !== 'undefined') doc.enabled = dto.enabled;
    if (typeof dto.name !== 'undefined') {
      const trimmed =
        typeof dto.name === 'string' ? dto.name.trim() : undefined;
      doc.name = trimmed ?? undefined;
    }
    if (dto.resetToken) doc.token = randomUUID();

    try {
      await doc.save();
    } catch (err) {
      this.handleDuplicateEmailError(err);
    }
    return this.toDto(doc.toObject() as unknown as StoredAppUser);
  }

  async remove(appId: string, userId: string): Promise<{ deleted: boolean }> {
    const res = await this.users.deleteOne({ appId, _id: userId });
    if (!res.deletedCount) throw new NotFoundException('User not found');
    return { deleted: true };
  }

  private toDto(doc: StoredAppUser): AppUserDtoShape {
    return {
      id: String(doc._id),
      appId: doc.appId,
      email: doc.email,
      role: doc.role,
      token: doc.token,
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
    token: string,
  ): Promise<AppUserDtoShape> {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedToken = token.trim();
    const doc = await this.users
      .findOne({
        appId,
        email: normalizedEmail,
        token: normalizedToken,
        enabled: true,
      })
      .lean<StoredAppUser | null>();
    if (!doc) throw new NotFoundException('Invalid credentials');
    return this.toDto(doc);
  }

  private toAppDto(
    doc: {
      appId: string;
      name?: string;
      enabled?: boolean;
      adminEmail?: string;
      createdAt?: Date;
      updatedAt?: Date;
      appSecret?: string;
    },
    includeSecret: boolean,
  ): AppSummaryShape {
    const base: AppSummaryShape = {
      appId: doc.appId,
      name: doc.name ?? doc.appId,
      enabled: typeof doc.enabled === 'boolean' ? doc.enabled : true,
      adminEmail: doc.adminEmail,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (includeSecret) {
      return { ...base, appSecret: doc.appSecret };
    }
    return base;
  }

  private toFallbackApp(appId: string): AppSummaryShape {
    return {
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
}
