import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { App, AppDocument } from '../../apps/schemas/app.schema';
import { hashSecret } from '../security/encryption.util';

@Injectable()
export class AppSecretGuard implements CanActivate {
  constructor(@InjectModel(App.name) private appModel: Model<AppDocument>) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const appId = extractHeader(req.headers['x-app-id']);
    const secret = extractHeader(req.headers['x-app-secret']);
    const appName = extractHeader(req.headers['x-app-name']);
    if (!appId || !secret) return false;
    const app = await this.appModel
      .findOne({
        appId,
        appSecretHash: hashSecret(secret),
        enabled: true,
      })
      .lean();
    if (!app) return false;
    if (appName && appName !== app.name) {
      try {
        await this.appModel.updateOne(
          { _id: app._id },
          { $set: { name: appName, updatedAt: new Date() } },
        );
      } catch {
        // Ignore name update failures so auth isn't blocked.
      }
    }
    req.appId = appId;
    req.tenantId = app.tenantId;
    return true;
  }
}

function extractHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}
