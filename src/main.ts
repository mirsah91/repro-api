import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express';
import { readFileSync } from 'fs';
import { createSecureLogger } from './common/security/secure-logger';
import { requireEncryptionKey } from './common/security/encryption.util';

async function bootstrap() {
  requireEncryptionKey();
  const httpsOptions = buildHttpsOptions();

  const app = await NestFactory.create(AppModule, {
    cors: true,
    ...(httpsOptions ? { httpsOptions } : {}),
    logger: createSecureLogger(),
  });
  app.use(express.json({ limit: '20mb' })); // requests
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));
  const config = new DocumentBuilder()
    .setTitle('Repro API')
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'x-sdk-token', in: 'header' }, 'sdkToken')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'appUser',
    )
    .addApiKey({ type: 'apiKey', name: 'x-app-id', in: 'header' }, 'appId')
    .addApiKey(
      { type: 'apiKey', name: 'x-app-secret', in: 'header' },
      'appSecret',
    )
    .addApiKey(
      { type: 'apiKey', name: 'x-admin-token', in: 'header' },
      'adminToken',
    )
    .build();

  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, doc, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(process.env.PORT || 4000);
}

bootstrap();

function buildHttpsOptions():
  | { key: Buffer; cert: Buffer; ca?: Buffer }
  | undefined {
  const keyPath = process.env.TLS_KEY_PATH;
  const certPath = process.env.TLS_CERT_PATH;
  const caPath = process.env.TLS_CA_PATH;

  if (!keyPath || !certPath) {
    if (!process.env.DISABLE_TLS_WARNING) {
      console.warn('[tls] TLS disabled - provide TLS_KEY_PATH and TLS_CERT_PATH to enable HTTPS');
    }
    return undefined;
  }

  try {
    const options: { key: Buffer; cert: Buffer; ca?: Buffer } = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
    if (caPath) {
      options.ca = readFileSync(caPath);
    }
    return options;
  } catch (err) {
    console.error('[tls] Failed to read TLS materials', err);
    return undefined;
  }
}
