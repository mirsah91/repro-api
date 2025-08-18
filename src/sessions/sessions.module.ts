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
        ]),
    ],
    controllers: [SessionsController],
    providers: [SessionsService],
    exports: [MongooseModule],
})
export class SessionsModule {}
