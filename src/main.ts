import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.use(express.json({ limit: '20mb' })); // requests
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));
  const config = new DocumentBuilder()
      .setTitle('Repro API')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'sdk')
      .addApiKey({ type: 'apiKey', name: 'x-app-id', in: 'header' }, 'appId')
      .addApiKey({ type: 'apiKey', name: 'x-app-secret', in: 'header' }, 'appSecret')
      .build();

  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, doc, { swaggerOptions: { persistAuthorization: true } });

  await app.listen(process.env.PORT || 4000);
}

bootstrap();
