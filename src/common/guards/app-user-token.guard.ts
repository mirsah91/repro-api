import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from '../../apps/schemas/app-user.schema';
import { APP_USER_ROLES_KEY } from '../decorators/app-user-roles.decorator';
import { hashSecret } from '../security/encryption.util';

@Injectable()
export class AppUserTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = (req.headers['x-app-user-token'] || '') as string;
    const tenantId = extractHeader(req.headers['x-tenant-id']) ?? req.tenantId;
    const requiredRoles = this.reflector.getAllAndOverride<
      AppUserRole[] | undefined
    >(APP_USER_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);

    if (!token || !tenantId) return false;

    const appId = this.resolveAppId(req);

    if (!appId) return false;

    const user = await this.users
      .findOne({
        tenantId,
        appId,
        tokenHash: hashSecret(token),
        enabled: true,
      })
      .lean();

    if (!user) return false;

    if (
      requiredRoles &&
      requiredRoles.length &&
      !requiredRoles.includes(user.role)
    ) {
      return false;
    }

    req.appId = appId;
    req.appUser = user;
    req.tenantId = tenantId;

    return true;
  }

  private resolveAppId(req: any): string | undefined {
    if (req.appId) return req.appId;
    if (req.params?.appId) return req.params.appId;

    const header = req.headers['x-app-id'];
    if (Array.isArray(header)) return header[0];
    if (header) return header;

    const query = req.query?.appId;
    if (Array.isArray(query)) return query[0];
    if (query) return query;

    const bodyAppId = req.body?.appId;
    if (Array.isArray(bodyAppId)) return bodyAppId[0];
    return bodyAppId;
  }
}

function extractHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}
