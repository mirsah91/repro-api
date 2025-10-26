import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { MongooseModule } from '@nestjs/mongoose';
import { App, AppSchema } from './schemas/app.schema';
import { AppUsersController } from './app-users.controller';
import { AppUsersService } from './app-users.service';
import { AppUser, AppUserSchema } from './schemas/app-user.schema';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: App.name, schema: AppSchema },
            { name: AppUser.name, schema: AppUserSchema },
        ]),
    ],
    controllers: [AppsController, AppUsersController],
    providers: [AppsService, AppUsersService, AppUserTokenGuard, AdminTokenGuard],
    exports: [MongooseModule],
})
export class AppsModule {}
