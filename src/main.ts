import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

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
