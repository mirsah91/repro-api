import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { App, AppDocument } from '../../apps/schemas/app.schema';

@Injectable()
export class AppSecretGuard implements CanActivate {
    constructor(@InjectModel(App.name) private appModel: Model<AppDocument>) {}
    async canActivate(ctx: ExecutionContext) {
        const req = ctx.switchToHttp().getRequest();
        const appId = req.headers['x-app-id'] as string;
        const secret = req.headers['x-app-secret'] as string;
        if (!appId || !secret) return false;
        const app = await this.appModel.findOne({ appId, appSecret: secret, enabled: true }).lean();
        if (!app) return false;
        req.appId = appId;
        return true;
    }
}
