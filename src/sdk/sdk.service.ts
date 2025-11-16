import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { App } from '../apps/schemas/app.schema';
import { SdkToken } from './schemas/sdk-token.schema';
import { randomUUID } from 'crypto';
import { encryptString, hashSecret } from '../common/security/encryption.util';
import { TenantContext } from '../common/tenant/tenant-context';

@Injectable()
export class SdkService {
  constructor(
    @InjectModel(App.name) private appModel: Model<App>,
    @InjectModel(SdkToken.name) private tokenModel: Model<SdkToken>,
    private readonly tenant: TenantContext,
  ) {}
  async bootstrap(appId: string) {
    console.log('data --->', {
      tenantId: this.tenant.tenantId,
      appId,
      enabled: true,
    });
    const app = await this.appModel
      .findOne({ tenantId: this.tenant.tenantId, appId, enabled: true })
      .lean();
    if (!app) return { enabled: false };
    const token = randomUUID();
    const exp = new Date(Date.now() + 60 * 60 * 1000);
    await this.tokenModel.create({
      tenantId: this.tenant.tenantId,
      appId,
      tokenHash: hashSecret(token),
      tokenEnc: encryptString(token),
      exp,
    });
    return {
      enabled: true,
      sdkToken: token,
      capture: { maskSelectors: [], maxMinutes: 5 },
    };
    // keep minimal for MVP
  }
}
