import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SdkToken, SdkTokenDocument } from '../../sdk/schemas/sdk-token.schema';

@Injectable()
export class SdkTokenGuard implements CanActivate {
  constructor(
    @InjectModel(SdkToken.name) private tokenModel: Model<SdkTokenDocument>,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    if (!auth) return false;
    const tok = await this.tokenModel
      .findOne({ token: auth, exp: { $gt: new Date() } })
      .lean();
    if (!tok) return false;
    req.appId = tok.appId;
    return true;
  }
}
