import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { App, AppDocument } from './schemas/app.schema';

@Injectable()
export class AppsService {
    constructor(@InjectModel(App.name) private model: Model<AppDocument>) {}
    async createApp(name?: string) {
        const appId = 'APP_' + randomUUID();
        const appSecret = randomUUID();
        await this.model.create({ appId, appSecret, name: name ?? appId, enabled: true });
        return { appId, appSecret };
    }
}
