import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppsModule } from './apps/apps.module';
import { SdkModule } from './sdk/sdk.module';
import { SessionsModule } from './sessions/sessions.module';
import { ViewerModule } from './viewer/viewer.module';

@Module({
  imports: [
    // Loads .env into process.env (globally)
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'], // keep simple; add '.env.local' if you want overrides
    }),

    // Use env for Mongo URI
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        uri: cfg.get<string>('MONGO_URI'),
      }),
    }),

    AppsModule,
    SdkModule,
    SessionsModule,
    ViewerModule,
  ],
})
export class AppModule {}
