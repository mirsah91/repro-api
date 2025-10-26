import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { App, AppDocument } from './schemas/app.schema';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from './schemas/app-user.schema';

@Injectable()
export class AppsService {
  constructor(
    @InjectModel(App.name) private readonly model: Model<AppDocument>,
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
  ) {}

  async createApp(name: string | undefined, adminEmail: string) {
    const appId = 'APP_' + randomUUID();
    const appSecret = randomUUID();
    const normalizedEmail = adminEmail.trim().toLowerCase();

    const createdApp = await this.model.create({
      appId,
      appSecret,
      name: name ?? appId,
      enabled: true,
      adminEmail: normalizedEmail,
    });

    const adminToken = randomUUID();
    const adminUser = await this.users.create({
      appId,
      email: normalizedEmail,
      role: AppUserRole.Admin,
      token: adminToken,
      enabled: true,
    });

    return {
      appId,
      appSecret,
      name: createdApp.name,
      enabled: createdApp.enabled,
      adminEmail: normalizedEmail,
      admin: this.toUserDto(adminUser.toObject()),
    };
  }

  async listApps() {
    const apps = await this.model.find().sort({ createdAt: -1 }).lean();
    return apps.map((app) => this.toAppDto(app));
  }

  async getApp(appId: string) {
    const app = await this.model.findOne({ appId }).lean();
    if (!app) throw new NotFoundException('App not found');
    return this.toAppDetailDto(app);
  }

  async updateApp(appId: string, update: { name?: string; enabled?: boolean }) {
    const app = await this.model.findOne({ appId });
    if (!app) throw new NotFoundException('App not found');
    if (typeof update.name !== 'undefined') app.name = update.name;
    if (typeof update.enabled !== 'undefined') app.enabled = update.enabled;
    await app.save();
    return this.toAppDetailDto(app.toObject());
  }

  async removeApp(appId: string) {
    const res = await this.model.deleteOne({ appId });
    if (!res.deletedCount) throw new NotFoundException('App not found');
    await this.users.deleteMany({ appId });
    return { deleted: true };
  }

  private toAppDto(doc: any) {
    return {
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
      appSecret: doc.appSecret,
    };
  }

  private toUserDto(doc: any) {
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
}
