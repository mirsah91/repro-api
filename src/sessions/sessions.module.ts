import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { Session, SessionSchema } from './schemas/session.schema';
import { Action, ActionSchema } from './schemas/action.schema';
import { RequestEvt, RequestEvtSchema } from './schemas/request.schema';
import { DbChange, DbChangeSchema } from './schemas/db-change.schema';
import { RrwebChunk, RrwebChunkSchema } from './schemas/rrweb-chunk.schema';
import { SdkToken, SdkTokenSchema } from '../sdk/schemas/sdk-token.schema';
import { App, AppSchema } from '../apps/schemas/app.schema';
import { EmailEvt, EmailEvtSchema } from './schemas/emails.schema';
import { TraceEvt, TraceEvtSchema } from './schemas/trace.schema';
import { AppUser, AppUserSchema } from '../apps/schemas/app-user.schema';
import { SdkTokenGuard } from '../common/guards/sdk-token.guard';
import { AppSecretGuard } from '../common/guards/app-secret.guard';
import { AppUserTokenGuard } from '../common/guards/app-user-token.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Action.name, schema: ActionSchema },
      { name: RequestEvt.name, schema: RequestEvtSchema },
      { name: DbChange.name, schema: DbChangeSchema },
      { name: RrwebChunk.name, schema: RrwebChunkSchema },
      { name: SdkToken.name, schema: SdkTokenSchema },
      { name: App.name, schema: AppSchema },
      { name: EmailEvt.name, schema: EmailEvtSchema },
      { name: TraceEvt.name, schema: TraceEvtSchema },
      { name: AppUser.name, schema: AppUserSchema },
    ]),
  ],
  controllers: [SessionsController],
  providers: [
    SessionsService,
    SdkTokenGuard,
    AppSecretGuard,
    AppUserTokenGuard,
  ],
  exports: [MongooseModule],
})
export class SessionsModule {}
