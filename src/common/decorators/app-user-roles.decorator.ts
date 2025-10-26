import { SetMetadata } from '@nestjs/common';
import { AppUserRole } from '../../apps/schemas/app-user.schema';

export const APP_USER_ROLES_KEY = 'appUserRoles';
export const AppUserRoles = (...roles: AppUserRole[]) =>
  SetMetadata(APP_USER_ROLES_KEY, roles);
