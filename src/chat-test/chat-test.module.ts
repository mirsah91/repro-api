import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatTestController } from './chat-test.controller';
import { ChatTestService } from './chat-test.service';
import { TenantModule } from '../common/tenant/tenant.module';
import { AppUser, AppUserSchema } from '../apps/schemas/app-user.schema';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AppUser.name, schema: AppUserSchema }]),
    TenantModule,
  ],
  controllers: [ChatTestController],
  providers: [ChatTestService, AppUserTokenGuard],
})
export class ChatTestModule {}
