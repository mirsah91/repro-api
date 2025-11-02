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
    const appId = req.headers['x-app-id'] as string;
    const secret = req.headers['x-app-secret'] as string;
    const tenantId = extractHeader(req.headers['x-tenant-id']);
    if (!appId || !secret || !tenantId) return false;
    const app = await this.appModel
      .findOne({
        tenantId,
        appId,
        appSecretHash: hashSecret(secret),
        enabled: true,
      })
      .lean();
    if (!app) return false;
    req.appId = appId;
    req.tenantId = tenantId;
    return true;
  }
}

function extractHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}
