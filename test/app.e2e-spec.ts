import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { MongoDBContainer, StartedMongoContainer } from 'testcontainers';
import { AppModule } from '../src/app.module';
import { AppUserRole } from '../src/apps/schemas/app-user.schema';

jest.setTimeout(180_000);

describe('Apps & App Users (integration)', () => {
  let app: INestApplication | undefined;
  let moduleFixture: TestingModule | undefined;
  let mongoContainer: StartedMongoContainer | undefined;
  let shouldSkip = false;
  const adminToken = 'integration-admin-token';

  beforeAll(async () => {
    try {
      mongoContainer = await new MongoDBContainer('mongo:7').start();
      process.env.MONGO_URI = mongoContainer.getConnectionString();
      process.env.ADMIN_TOKEN = adminToken;

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    } catch (err) {
      shouldSkip = true;
      console.warn('Skipping integration tests because Mongo container failed to start.', err);
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

  it('provisions apps and manages members with guard enforcement', async () => {
    if (shouldSkip || !app) {
      console.warn('Integration test skipped - environment does not support Docker testcontainers.');
      return;
    }
    const server = app.getHttpServer();

    const createAppResponse = await request(server)
      .post('/v1/apps')
      .set('x-admin-token', adminToken)
      .send({ name: 'integration-app', adminEmail: 'owner@example.com' })
      .expect(201);

    expect(createAppResponse.body).toEqual(
      expect.objectContaining({
        appId: expect.stringMatching(/^APP_/),
        appSecret: expect.any(String),
        name: 'integration-app',
        enabled: true,
        adminEmail: 'owner@example.com',
        admin: expect.objectContaining({
          email: 'owner@example.com',
          role: AppUserRole.Admin,
          token: expect.any(String),
        }),
      }),
    );

    const { appId, admin } = createAppResponse.body;
    const adminUserToken: string = admin.token;

    await request(server)
      .get('/v1/apps')
      .set('x-admin-token', adminToken)
      .expect(200)
      .expect(res => {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.find((appSummary: any) => appSummary.appId === appId)).toMatchObject({
          name: 'integration-app',
          enabled: true,
        });
      });

    const updatedApp = await request(server)
      .patch(`/v1/apps/${appId}`)
      .set('x-admin-token', adminToken)
      .send({ name: 'renamed app', enabled: false })
      .expect(200);

    expect(updatedApp.body).toMatchObject({
      appId,
      name: 'renamed app',
      enabled: false,
      appSecret: createAppResponse.body.appSecret,
    });

    await request(server)
      .get(`/v1/apps/${appId}`)
      .set('x-admin-token', adminToken)
      .expect(200)
      .expect(res => {
        expect(res.body).toMatchObject({
          appId,
          name: 'renamed app',
          enabled: false,
        });
      });

    await request(server)
      .get(`/v1/apps/${appId}/users`)
      .expect(403);

    await request(server)
      .post(`/v1/apps/${appId}/users`)
      .set('x-app-user-token', 'wrong-token')
      .send({ email: 'intruder@example.com' })
      .expect(403);

    const createdUser = await request(server)
      .post(`/v1/apps/${appId}/users`)
      .set('x-app-user-token', adminUserToken)
      .send({ email: 'viewer@example.com', name: 'Viewer One', role: AppUserRole.Viewer })
      .expect(201);

    expect(createdUser.body).toMatchObject({
      appId,
      email: 'viewer@example.com',
      role: AppUserRole.Viewer,
      enabled: true,
      name: 'Viewer One',
    });

    const createdUserId = createdUser.body.id;
    const originalToken = createdUser.body.token;

    const listUsersResponse = await request(server)
      .get(`/v1/apps/${appId}/users`)
      .set('x-app-user-token', adminUserToken)
      .expect(200);

    expect(listUsersResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: admin.id, email: 'owner@example.com' }),
        expect.objectContaining({ id: createdUserId, email: 'viewer@example.com' }),
      ]),
    );

    const fetchedUser = await request(server)
      .get(`/v1/apps/${appId}/users/${createdUserId}`)
      .set('x-app-user-token', adminUserToken)
      .expect(200);

    expect(fetchedUser.body).toMatchObject({
      id: createdUserId,
      email: 'viewer@example.com',
      role: AppUserRole.Viewer,
    });

    const updatedUser = await request(server)
      .patch(`/v1/apps/${appId}/users/${createdUserId}`)
      .set('x-app-user-token', adminUserToken)
      .send({ role: AppUserRole.Recorder, resetToken: true, enabled: false })
      .expect(200);

    expect(updatedUser.body).toMatchObject({
      id: createdUserId,
      role: AppUserRole.Recorder,
      enabled: false,
    });
    expect(updatedUser.body.token).not.toEqual(originalToken);

    await request(server)
      .delete(`/v1/apps/${appId}/users/${createdUserId}`)
      .set('x-app-user-token', adminUserToken)
      .expect(200)
      .expect({ deleted: true });

    const listAfterDelete = await request(server)
      .get(`/v1/apps/${appId}/users`)
      .set('x-app-user-token', adminUserToken)
      .expect(200);

    expect(listAfterDelete.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: admin.id, email: 'owner@example.com' }),
      ]),
    );

    await request(server)
      .delete(`/v1/apps/${appId}`)
      .set('x-admin-token', adminToken)
      .expect(200)
      .expect({ deleted: true });

    await request(server)
      .get(`/v1/apps/${appId}`)
      .set('x-admin-token', adminToken)
      .expect(404);
  });
});
