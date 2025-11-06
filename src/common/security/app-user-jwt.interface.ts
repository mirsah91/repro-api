import { AppUserRole } from '../../apps/schemas/app-user.schema';

export interface AppUserJwtPayload {
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
}
