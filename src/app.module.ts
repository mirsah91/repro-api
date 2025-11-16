import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { AppsModule } from './apps/apps.module';
import { SdkModule } from './sdk/sdk.module';
import { SessionsModule } from './sessions/sessions.module';
import { ViewerModule } from './viewer/viewer.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    // Loads .env files (local overrides first) into process.env
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(__dirname, '..', '.env.local'),
        join(__dirname, '..', '.env'),
        '.env.local',
        '.env',
      ],
    }),

    // Use env for Mongo URI
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const uri = cfg.get<string>('MONGO_URI');
        if (!uri) {
          throw new Error('MONGO_URI must be configured');
        }

        const enableTls = cfg.get<string>('MONGO_TLS') !== 'false';
        const tlsAllowInvalid =
          cfg.get<string>('MONGO_TLS_ALLOW_INVALID_CERTS') === 'true';
        const tlsCAFile = cfg.get<string>('MONGO_TLS_CA');

        const options: Record<string, any> = {
          uri,
        };

        if (enableTls) {
          options.tls = true;
          if (tlsCAFile) {
            options.tlsCAFile = tlsCAFile;
          }
          if (tlsAllowInvalid) {
            options.tlsAllowInvalidCertificates = true;
          }
        }

        return options;
      },
    }),

    AppsModule,
    SdkModule,
    SessionsModule,
    ViewerModule,
    ChatModule,
  ],
})
export class AppModule {}
