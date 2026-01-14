import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { App, AppDocument } from '../../apps/schemas/app.schema';
import { SdkToken, SdkTokenDocument } from '../../sdk/schemas/sdk-token.schema';
import { hashSecret } from '../security/encryption.util';

@Injectable()
export class SdkTokenGuard implements CanActivate {
  constructor(
    @InjectModel(SdkToken.name) private tokenModel: Model<SdkTokenDocument>,
    @InjectModel(App.name) private appModel: Model<AppDocument>,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const headerToken = extractHeader(req.headers['x-sdk-token']);
    const bearerToken = extractBearer(req.headers['authorization']);
    const auth = headerToken ?? bearerToken;
    if (!auth) return false;
    const tok = await this.tokenModel
      .findOne({
        tokenHash: hashSecret(auth),
        exp: { $gt: new Date() },
      })
      .lean();
    if (!tok) return false;
    const app = await this.appModel.findOne({ appId: tok.appId }).lean();
    if (!app) return false;
    if (tok.tenantId && app.tenantId !== tok.tenantId) {
      return false;
    }
    const appName = extractHeader(req.headers['x-app-name']);
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
    req.appId = tok.appId;
    req.tenantId = app.tenantId;
    return true;
  }
}

function extractHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function extractBearer(value: unknown): string | undefined {
  const header = extractHeader(value);
  if (!header) return undefined;
  if (!/^bearer\s+/i.test(header)) {
    return undefined;
  }
  return header.replace(/^bearer\s+/i, '').trim();
}
