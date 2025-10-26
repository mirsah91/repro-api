import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { App } from '../apps/schemas/app.schema';
import { SdkToken } from './schemas/sdk-token.schema';
import { randomUUID } from 'crypto';

@Injectable()
export class SdkService {
  constructor(
    @InjectModel(App.name) private appModel: Model<App>,
    @InjectModel(SdkToken.name) private tokenModel: Model<SdkToken>,
  ) {}
  async bootstrap(appId: string) {
    const app = await this.appModel.findOne({ appId, enabled: true }).lean();
    if (!app) return { enabled: false };
    const token = randomUUID();
    const exp = new Date(Date.now() + 60 * 60 * 1000);
    await this.tokenModel.create({ appId, token, exp });
    return {
      enabled: true,
      sdkToken: token,
      capture: { maskSelectors: [], maxMinutes: 5 },
    };
    // keep minimal for MVP
  }
}
