import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { verifyJwt } from '../security/jwt.util';
import {
  AppUser,
  AppUserDocument,
  AppUserRole,
} from '../../apps/schemas/app-user.schema';
import { APP_USER_ROLES_KEY } from '../decorators/app-user-roles.decorator';

@Injectable()
export class AppUserTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(AppUser.name) private readonly users: Model<AppUserDocument>,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const tenantId = extractHeader(req.headers['x-tenant-id']) ?? req.tenantId;
    const requiredRoles = this.reflector.getAllAndOverride<
      AppUserRole[] | undefined
    >(APP_USER_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);

    const bearerToken = extractBearer(req.headers['authorization']);
    if (!bearerToken) {
      return false;
    }

    return this.validateJwtToken({
      req,
      token: bearerToken,
      tenantId,
      requiredRoles,
    });
  }

  private async validateJwtToken(params: {
    req: any;
    token: string;
    tenantId?: string;
    requiredRoles?: AppUserRole[];
  }): Promise<boolean> {
    const { req, token, tenantId, requiredRoles } = params;
    const secret = this.getJwtSecret();

    let payload: AppUserJwtPayload;
    try {
      payload = verifyJwt<AppUserJwtPayload>(token, secret, {
        issuer: 'repro-api',
        ...(tenantId ? { audience: tenantId } : {}),
      });
    } catch {
      return false;
    }

    if (!payload.sub || !payload.appId || !payload.tenantId) {
      return false;
    }

    const resolvedTenantId = tenantId ?? payload.tenantId;
    if (!resolvedTenantId || resolvedTenantId !== payload.tenantId) {
      return false;
    }

    const user = await this.users
      .findOne({
        tenantId: payload.tenantId,
        appId: payload.appId,
        _id: payload.sub,
        enabled: true,
      })
      .lean();

    if (!user) return false;

    if (
      payload.tokenHash &&
      user.tokenHash &&
      payload.tokenHash !== user.tokenHash
    ) {
      return false;
    }

    if (
      requiredRoles &&
      requiredRoles.length &&
      !requiredRoles.includes(user.role as AppUserRole)
    ) {
      return false;
    }

    req.appId = payload.appId;
    req.appUser = user;
    req.tenantId = payload.tenantId;

    return true;
  }

  private getJwtSecret(): string {
    const secret = this.config.get<string>('APP_USER_JWT_SECRET');
    if (!secret) {
      throw new Error('APP_USER_JWT_SECRET must be configured');
    }
    return secret;
  }

}

type AppUserJwtPayload = {
  sub: string;
  tenantId: string;
  appId: string;
  role: AppUserRole;
  email: string;
  tokenHash?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
};

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
