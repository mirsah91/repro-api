import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { MongooseModule } from '@nestjs/mongoose';
import { App, AppSchema } from './schemas/app.schema';
import { AppUsersController } from './app-users.controller';
import { AppUsersService } from './app-users.service';
import { AppUser, AppUserSchema } from './schemas/app-user.schema';
import {
  AppUserPasswordReset,
  AppUserPasswordResetSchema,
} from './schemas/app-user-password-reset.schema';
import { AppUserPasswordResetService } from './app-user-password-reset.service';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { AppUsersAuthController } from './app-users-auth.controller';
import { InitController } from './init.controller';
import { TenantModule } from '../common/tenant/tenant.module';
import { Session, SessionSchema } from '../sessions/schemas/session.schema';
import { Action, ActionSchema } from '../sessions/schemas/action.schema';
import {
  RequestEvt,
  RequestEvtSchema,
} from '../sessions/schemas/request.schema';
import { DbChange, DbChangeSchema } from '../sessions/schemas/db-change.schema';
import { EmailEvt, EmailEvtSchema } from '../sessions/schemas/emails.schema';
import { TraceEvt, TraceEvtSchema } from '../sessions/schemas/trace.schema';
import {
  TraceSummary,
  TraceSummarySchema,
} from '../sessions/schemas/trace-summary.schema';
import { SessionSummaryService } from '../sessions/session-summary.service';
import {
  TraceNode,
  TraceNodeSchema,
} from '../sessions/schemas/trace-node.schema';
import {
  SessionChatMessage,
  SessionChatMessageSchema,
} from '../sessions/schemas/session-chat.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: App.name, schema: AppSchema },
      { name: AppUser.name, schema: AppUserSchema },
      { name: AppUserPasswordReset.name, schema: AppUserPasswordResetSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Action.name, schema: ActionSchema },
      { name: RequestEvt.name, schema: RequestEvtSchema },
      { name: DbChange.name, schema: DbChangeSchema },
      { name: EmailEvt.name, schema: EmailEvtSchema },
      { name: TraceEvt.name, schema: TraceEvtSchema },
      { name: TraceSummary.name, schema: TraceSummarySchema },
      { name: TraceNode.name, schema: TraceNodeSchema },
      { name: SessionChatMessage.name, schema: SessionChatMessageSchema },
    ]),
    TenantModule,
  ],
  controllers: [
    AppsController,
    AppUsersController,
    AppUsersAuthController,
    InitController,
  ],
  providers: [
    AppsService,
    AppUsersService,
    AppUserPasswordResetService,
    AppUserTokenGuard,
    SessionSummaryService,
  ],
  exports: [MongooseModule],
})
export class AppsModule {}
