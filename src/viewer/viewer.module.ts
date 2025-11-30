import { Module } from '@nestjs/common';
import { ViewerController } from './viewer.controller';
import { ViewerService } from './viewer.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from '../sessions/schemas/session.schema';
import { Action, ActionSchema } from '../sessions/schemas/action.schema';
import {
  RequestEvt,
  RequestEvtSchema,
} from '../sessions/schemas/request.schema';
import { DbChange, DbChangeSchema } from '../sessions/schemas/db-change.schema';
import { RrwebChunk } from '../sessions/schemas/rrweb-chunk.schema';
import { EmailEvt, EmailEvtSchema } from '../sessions/schemas/emails.schema';
import { AppUser, AppUserSchema } from '../apps/schemas/app-user.schema';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';
import { TenantModule } from '../common/tenant/tenant.module';
import { TraceEvt, TraceEvtSchema } from '../sessions/schemas/trace.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Action.name, schema: ActionSchema },
      { name: RequestEvt.name, schema: RequestEvtSchema },
      { name: DbChange.name, schema: DbChangeSchema },
      { name: RrwebChunk.name, schema: RrwebChunk },
      { name: EmailEvt.name, schema: EmailEvtSchema },
      { name: AppUser.name, schema: AppUserSchema },
      { name: TraceEvt.name, schema: TraceEvtSchema },
    ]),
    TenantModule,
  ],
  controllers: [ViewerController],
  providers: [ViewerService, AppUserTokenGuard],
})
export class ViewerModule {}
