import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { MongooseModule } from '@nestjs/mongoose';
import { App, AppSchema } from './schemas/app.schema';
import { AppUsersController } from './app-users.controller';
import { AppUsersService } from './app-users.service';
import { AppUser, AppUserSchema } from './schemas/app-user.schema';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUsersAuthController } from './app-users-auth.controller';
import { InitController } from './init.controller';
import { TenantModule } from '../common/tenant/tenant.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: App.name, schema: AppSchema },
      { name: AppUser.name, schema: AppUserSchema },
    ]),
    TenantModule,
  ],
  controllers: [
    AppsController,
    AppUsersController,
    AppUsersAuthController,
    InitController,
  ],
  providers: [AppsService, AppUsersService, AppUserTokenGuard],
  exports: [MongooseModule],
})
export class AppsModule {}
