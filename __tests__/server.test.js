import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const locationCalls = [];
mock.module('../lib/logger.js', {
  namedExports: {
    info() {},
    error() {},
    location(msg) { locationCalls.push(msg); },
    LOCATION_LOG_PATH: '',
  },
});

const { createApp } = await import('../server.js');
const { default: request } = await import('supertest');

const TEST_DATA_DIR = path.join(import.meta.dirname, '../data-test-server');
const TEST_USER = 'joel';
const TEST_PASS = 'secret123';

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('POST /pub', () => {
  let app;

  before(() => {
    app = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
    });
  });

  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    locationCalls.length = 0;
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('returns 401 with no auth header', async () => {
    const res = await request(app)
      .post('/pub')
      .send({ _type: 'location', lat: 33.99, lon: -117.87 });
    assert.equal(res.status, 401);
  });

  it('returns 401 with wrong credentials', async () => {
    const res = await request(app)
      .post('/pub')
      .set('Authorization', basicAuth('wrong', 'creds'))
      .send({ _type: 'location', lat: 33.99, lon: -117.87 });
    assert.equal(res.status, 401);
  });

  it('returns 200 with empty JSON array on success', async () => {
    const res = await request(app)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .set('X-Limit-D', 'phone')
      .send({ _type: 'location', lat: 33.99, lon: -117.87, tst: 1711036800 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('stores the location in a JSONL file', async () => {
    await request(app)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .set('X-Limit-D', 'myphone')
      .send({ _type: 'location', lat: 33.99, lon: -117.87, tst: 1711036800, acc: 15 });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const line = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(line);

    assert.equal(parsed.username, TEST_USER);
    assert.equal(parsed.device, 'myphone');
    assert.equal(parsed.lat, 33.99);
    assert.equal(parsed.lon, -117.87);
    assert.equal(parsed.type, 'location');
    assert.ok(parsed.received_at, 'should have received_at timestamp');
  });

  it('uses "phone" as default device when X-Limit-D is missing', async () => {
    await request(app)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.99, lon: -117.87, tst: 1711036800 });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim());
    assert.equal(parsed.device, 'phone');
  });

  it('returns 400 for non-JSON body', async () => {
    const res = await request(app)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .set('Content-Type', 'text/plain')
      .send('not json');
    assert.equal(res.status, 400);
  });

  it('returns 400 for a JSON array body', async () => {
    const res = await request(app)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send([{ _type: 'location' }]);
    assert.equal(res.status, 400);
  });

  it('skips POI detection when lat/lon are missing from body', async () => {
    const detector = {
      detect: () => { throw new Error('should not be called'); },
    };
    const appWithDetector = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
    });
    const res = await request(appWithDetector)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', event: 'enter', tst: 1711036800 });
    assert.equal(res.status, 200);
    assert.equal(locationCalls.length, 0);
  });

  it('calls discord.notify on POI transition', async () => {
    const notified = [];
    const detector = {
      detect: () => ({ changed: true, location: 'Home', previousLocation: 'Roaming' }),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });
    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902 });
    assert.equal(notified.length, 1);
    assert.equal(notified[0], 'Arrived at Home');
  });

  it('sends "Left" message when transitioning to Roaming', async () => {
    const notified = [];
    const detector = {
      detect: () => ({ changed: true, location: 'Roaming', previousLocation: 'Home' }),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });
    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.021, lon: -117.902 });
    assert.equal(notified[0], 'Left Home (now Roaming)');
  });

  it('does not call discord.notify when no transition', async () => {
    const notified = [];
    const detector = {
      detect: () => ({ changed: false, location: 'Home', previousLocation: 'Home' }),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });
    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902 });
    assert.equal(notified.length, 0);
  });

  it('calls activity.update on location entries when activity detector exists', async () => {
    const activityCalls = [];
    const activity = {
      update: (lat, lon, tst, vel) => {
        activityCalls.push({ lat, lon, tst, vel });
        return { changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false };
      },
      getFullState: () => ({}),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 5 });
    assert.equal(activityCalls.length, 1);
    assert.equal(activityCalls[0].lat, 34.017);
    assert.equal(activityCalls[0].lon, -117.902);
    assert.equal(activityCalls[0].tst, 1711036800);
    assert.equal(activityCalls[0].vel, 5);
  });

  it('skips activity detection for non-location entries', async () => {
    const activityCalls = [];
    const activity = {
      update: (lat, lon, tst, vel) => {
        activityCalls.push({ lat, lon, tst, vel });
        return { changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false };
      },
      getFullState: () => ({}),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', lat: 34.017, lon: -117.902, tst: 1711036800 });
    assert.equal(activityCalls.length, 0);
  });

  it('sends Discord notification on activity state change', async () => {
    const notified = [];
    const activity = {
      update: () => ({ changed: true, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      activityConfig: { discord_notifications: true },
      discord,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800 });
    assert.equal(notified.length, 1);
    assert.equal(notified[0], 'Now Driving');
  });

  it('does not send Discord notification when discord_notifications is false', async () => {
    const notified = [];
    const activity = {
      update: () => ({ changed: true, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      activityConfig: { discord_notifications: false },
      discord,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800 });
    const activityNotifications = notified.filter(msg => msg.startsWith('Now '));
    assert.equal(activityNotifications.length, 0);
  });

  it('fires both POI and activity notifications on same point', async () => {
    const notified = [];
    const detector = {
      detect: () => ({ changed: true, location: 'Home', previousLocation: 'Roaming' }),
    };
    const activity = {
      update: () => ({ changed: true, state: 'WALKING', previousState: 'STATIONARY', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithBoth = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      activityConfig: { discord_notifications: true },
      discord,
    });
    await request(appWithBoth)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800 });
    assert.equal(notified.length, 2);
    assert.ok(notified.some(msg => msg === 'Arrived at Home'), 'should have POI notification');
    assert.ok(notified.some(msg => msg === 'Now Walking'), 'should have activity notification');
  });

  it('persists activity state on initialClassification', async () => {
    const persistCalls = [];
    const fullState = { state: 'STATIONARY', points: [] };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: true }),
      getFullState: () => fullState,
    };
    const onActivityPersist = (state) => persistCalls.push(state);
    const appWithPersist = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      onActivityPersist,
    });
    await request(appWithPersist)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800 });
    assert.equal(persistCalls.length, 1);
    assert.deepEqual(persistCalls[0], fullState);
  });
});
