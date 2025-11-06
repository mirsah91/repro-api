import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SdkToken, SdkTokenDocument } from '../../sdk/schemas/sdk-token.schema';
import { hashSecret } from '../security/encryption.util';

@Injectable()
export class SdkTokenGuard implements CanActivate {
  constructor(
    @InjectModel(SdkToken.name) private tokenModel: Model<SdkTokenDocument>,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const headerToken = extractHeader(req.headers['x-sdk-token']);
    const bearerToken = extractBearer(req.headers['authorization']);
    const auth = headerToken ?? bearerToken;
    const tenantId = extractHeader(req.headers['x-tenant-id']);
    if (!auth || !tenantId) return false;
    const tok = await this.tokenModel
      .findOne({
        tenantId,
        tokenHash: hashSecret(auth),
        exp: { $gt: new Date() },
      })
      .lean();
    if (!tok) return false;
    req.appId = tok.appId;
    req.tenantId = tenantId;
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
