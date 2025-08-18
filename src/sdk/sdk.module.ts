import { Module } from '@nestjs/common';
import { SdkController } from './sdk.controller';
import { SdkService } from './sdk.service';
import { MongooseModule } from '@nestjs/mongoose';
import { App, AppSchema } from '../apps/schemas/app.schema';
import { SdkToken, SdkTokenSchema } from './schemas/sdk-token.schema';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: App.name, schema: AppSchema },
            { name: SdkToken.name, schema: SdkTokenSchema },
        ]),
    ],
    controllers: [SdkController],
    providers: [SdkService],
    exports: [MongooseModule],
})
export class SdkModule {}
