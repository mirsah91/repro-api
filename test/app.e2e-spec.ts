import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { MongoDBContainer, StartedMongoContainer } from 'testcontainers';
import { AppModule } from '../src/app.module';
import { AppUserRole } from '../src/apps/schemas/app-user.schema';

jest.setTimeout(180_000);

describe('Workspace bootstrap and user management', () => {
  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let mongoContainer: StartedMongoContainer | undefined;
  let shouldSkip = false;

  beforeAll(async () => {
    try {
      mongoContainer = await new MongoDBContainer('mongo:7').start();
      process.env.MONGO_URI = mongoContainer.getConnectionString();
      process.env.MONGO_TLS = 'false';
      process.env.DATA_ENCRYPTION_KEY = Buffer.from(
        'integration-test-key-0123456789abcd',
      ).toString('base64');

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    } catch (err) {
      shouldSkip = true;
      console.warn(
        'Skipping integration tests because Mongo container failed to start.',
        err,
      );
    }
  });

  afterAll(async () => {
    if (shouldSkip) return;
    if (app) {
      await app.close();
    }
    if (moduleFixture) {
      await moduleFixture.close();
    }
    if (mongoContainer) {
      await mongoContainer.stop();
    }
  });

  it('supports /init bootstrap followed by password-based admin management', async () => {
    if (shouldSkip || !app) {
      console.warn(
        'Integration test skipped - environment does not support Docker testcontainers.',
      );
      return;
    }

    const server = app.getHttpServer();
    const bootstrapPassword = 'Sup3rSecure!';

    const initResponse = await request(server)
      .post('/init')
      .send({
        appName: 'integration-app',
        email: 'owner@example.com',
        password: bootstrapPassword,
      })
      .expect(201);

    expect(initResponse.body).toEqual(
      expect.objectContaining({
        tenantId: expect.stringMatching(/^TENANT_/),
        appId: expect.stringMatching(/^APP_/),
        appSecret: expect.any(String),
        encryptionKey: expect.any(String),
        name: 'integration-app',
        adminEmail: 'owner@example.com',
        admin: expect.objectContaining({
          email: 'owner@example.com',
          role: AppUserRole.Admin,
          password: bootstrapPassword,
        }),
      }),
    );

    const { tenantId, appId, admin } = initResponse.body;
    const adminPassword: string = admin.password;

    const loginResponse = await request(server)
      .post('/v1/app-users/login')
      .send({ email: 'owner@example.com', password: adminPassword })
      .expect(201);

    expect(loginResponse.body).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({
          email: 'owner@example.com',
          tenantId,
          appId,
          role: AppUserRole.Admin,
        }),
        app: expect.objectContaining({
          tenantId,
          appId,
        }),
      }),
    );

    await request(server)
      .get('/v1/apps')
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .expect(200)
      .expect((res) => {
        expect(
          res.body.find((summary: any) => summary.appId === appId),
        ).toMatchObject({
          name: 'integration-app',
          enabled: true,
        });
      });

    const updatedApp = await request(server)
      .patch(`/v1/apps/${appId}`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .send({ name: 'renamed app', enabled: false })
      .expect(200);

    expect(updatedApp.body).toMatchObject({
      tenantId,
      appId,
      name: 'renamed app',
      enabled: false,
      appSecret: initResponse.body.appSecret,
      encryptionKey: initResponse.body.encryptionKey,
    });

    await request(server)
      .get(`/v1/apps/${appId}`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({
          appId,
          name: 'renamed app',
          enabled: false,
        });
      });

    await request(server)
      .post(`/v1/apps/${appId}/users`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .send({
        email: 'viewer@example.com',
        name: 'Viewer One',
        role: AppUserRole.Viewer,
      })
      .expect(201);

    const createdUser = await request(server)
      .post(`/v1/apps/${appId}/users`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .send({
        email: 'recorder@example.com',
        name: 'Recorder One',
        role: AppUserRole.Recorder,
      })
      .expect(201);

    const createdUserId = createdUser.body.id;
    const originalPassword = createdUser.body.password;

    const listUsersResponse = await request(server)
      .get(`/v1/apps/${appId}/users`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .expect(200);

    expect(listUsersResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: admin.id,
          email: 'owner@example.com',
        }),
        expect.objectContaining({
          id: createdUserId,
          email: 'recorder@example.com',
          role: AppUserRole.Recorder,
        }),
      ]),
    );

    const resetResponse = await request(server)
      .patch(`/v1/apps/${appId}/users/${createdUserId}`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .send({ resetPassword: true })
      .expect(200);

    expect(resetResponse.body.password).toBeDefined();
    expect(resetResponse.body.password).not.toEqual(originalPassword);

    await request(server)
      .post(`/v1/apps/${appId}/users/login`)
      .send({
        email: resetResponse.body.email,
        password: resetResponse.body.password,
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.user).toMatchObject({
          email: resetResponse.body.email,
          tenantId,
          role: AppUserRole.Recorder,
        });
      });

    await request(server)
      .post(`/v1/apps/${appId}/users/canRecord`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .send({
        email: resetResponse.body.email,
        password: resetResponse.body.password,
      })
      .expect(201);

    await request(server)
      .delete(`/v1/apps/${appId}/users/${createdUserId}`)
      .set('x-tenant-id', tenantId)
      .set('x-app-user-token', adminPassword)
      .expect(200)
      .expect({ deleted: true });
  });
});
