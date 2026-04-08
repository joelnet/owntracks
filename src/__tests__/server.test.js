import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../lib/db.js';
import { createStore } from '../lib/store.js';

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

const TEST_USER = 'joel';
const TEST_PASS = 'secret123';

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function createTestStore() {
  const db = new Database(':memory:');
  initSchema(db);
  return { store: createStore(db), db };
}

describe('POST /pub', () => {
  let app;
  let testDb;

  before(() => {
    const { store, db } = createTestStore();
    testDb = db;
    app = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
    });
  });

  beforeEach(() => {
    locationCalls.length = 0;
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
    const { store, db } = createTestStore();
    const testApp = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
    });
    await request(testApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .set('X-Limit-D', 'myphone')
      .send({ _type: 'location', lat: 33.99, lon: -117.87, tst: 1711036800, acc: 15 });

    const row = db.prepare('SELECT * FROM location_entries').get();
    const parsed = JSON.parse(row.data);

    assert.equal(parsed.username, TEST_USER);
    assert.equal(parsed.device, 'myphone');
    assert.equal(parsed.lat, 33.99);
    assert.equal(parsed.lon, -117.87);
    assert.equal(parsed.type, 'location');
    assert.ok(parsed.received_at, 'should have received_at timestamp');
  });

  it('uses "phone" as default device when X-Limit-D is missing', async () => {
    const { store, db } = createTestStore();
    const testApp = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
    });
    await request(testApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.99, lon: -117.87, tst: 1711036800 });

    const row = db.prepare('SELECT * FROM location_entries').get();
    const parsed = JSON.parse(row.data);
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
    const { store } = createTestStore();
    const appWithDetector = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithBoth = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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
    const { store } = createTestStore();
    const appWithPersist = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
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

  it('calls visit.processPoint on location entries when visit detector exists', async () => {
    const visitCalls = [];
    const visit = {
      processPoint: (point, poiResult, activityState) => {
        visitCalls.push({ point, poiResult, activityState });
        return null;
      },
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(visitCalls.length, 1);
    assert.equal(visitCalls[0].point.lat, 34.05);
    assert.equal(visitCalls[0].poiResult, 'Roaming');
    assert.equal(visitCalls[0].activityState, 'STATIONARY');
  });

  it('sends Discord notification on visit_started event with geocoded address', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_started',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
      }),
      getState: () => ({ active: true }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
      reverseGeocode: async () => 'Target, 1234 E Foothill Blvd, Azusa, CA',
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg === 'POI Lookup at Target, 1234 E Foothill Blvd, Azusa, CA'));
  });

  it('sends failure message when reverseGeocode returns null', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_started',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
      }),
      getState: () => ({ active: true }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
      reverseGeocode: async () => null,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg === 'POI Lookup failed for (34.0500, -117.9500)'));
  });

  it('sends Discord notification on visit_ended event', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_ended',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
        ended_at: '2026-03-29T15:15:00Z',
        duration_minutes: 45,
      }),
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'DRIVING',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg.includes('Left unknown location') && msg.includes('45 min')));
  });

  it('sends Discord notification on visit_ended event with geocoded address', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_ended',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
        ended_at: '2026-03-29T15:15:00Z',
        duration_minutes: 45,
      }),
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'DRIVING',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
      reverseGeocode: async () => 'Costco, 2000 Market Place Drive, Monterey Park, CA',
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg === 'Left Costco, 2000 Market Place Drive, Monterey Park, CA — 45 min visit'));
  });

  it('does not send visit Discord notification when discord_notifications is false', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_started',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
      }),
      getState: () => ({ active: true }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: false },
      discord,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    const visitNotifications = notified.filter(msg => msg.includes('POI Lookup') || msg.includes('Left unknown'));
    assert.equal(visitNotifications.length, 0);
  });

  it('persists visit state via onVisitPersist callback', async () => {
    const persistCalls = [];
    const visit = {
      processPoint: () => null,
      getState: () => ({ active: true, anchor: { lat: 34.05, lon: -117.95 } }),
      getLearnedPois: () => [{ name: 'Test', lat: 34.05, lon: -117.95 }],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
      resolveLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const onVisitPersist = (state, pois) => persistCalls.push({ state, pois });
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
      onVisitPersist,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].state.active, true);
    assert.equal(persistCalls[0].pois.length, 1);
  });

  it('skips visit detection for non-location entries', async () => {
    const visitCalls = [];
    const visit = {
      processPoint: (point) => { visitCalls.push(point); return null; },
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const { store } = createTestStore();
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      visit,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(visitCalls.length, 0);
  });

  it('resets POI pending state when point is filtered by accuracy', async () => {
    let resetCalled = false;
    const detector = {
      detect: () => ({ changed: false, location: 'Home', previousLocation: 'Home' }),
      resetPending: () => { resetCalled = true; },
    };
    const { store } = createTestStore();
    const appWithFilter = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      maxAccuracy: 30,
    });
    await request(appWithFilter)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, acc: 50, tst: 1711036800 });
    assert.equal(resetCalled, true);
  });

  it('does not reset POI pending state when point passes accuracy filter', async () => {
    let resetCalled = false;
    const detector = {
      detect: () => ({ changed: false, location: 'Home', previousLocation: 'Home' }),
      resetPending: () => { resetCalled = true; },
    };
    const { store } = createTestStore();
    const appWithFilter = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      maxAccuracy: 30,
    });
    await request(appWithFilter)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, acc: 10, tst: 1711036800 });
    assert.equal(resetCalled, false);
  });

  it('substitutes server time when phone re-sends the same tst (stale GPS fix)', async () => {
    const activityCalls = [];
    const visitCalls = [];
    const activity = {
      update: (lat, lon, tst, vel) => {
        activityCalls.push({ lat, lon, tst, vel });
        return { changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false };
      },
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const visit = {
      processPoint: (point, poiResult, activityState) => {
        visitCalls.push({ point, poiResult, activityState });
        return null;
      },
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      resolveLocation: () => 'Roaming',
    };
    const { store } = createTestStore();
    const staleTstApp = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      detector,
      activity,
      visit,
    });

    const staleTst = 1711036800;

    // First request: tst is new, passed through unchanged
    await request(staleTstApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.996, lon: -117.930, tst: staleTst, vel: 0 });

    assert.equal(activityCalls[0].tst, staleTst);
    assert.equal(visitCalls[0].point.tst, staleTst);

    // Second request: same tst re-sent — detectors should get a different (server) timestamp
    await request(staleTstApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.996, lon: -117.930, tst: staleTst, vel: 0 });

    assert.notEqual(activityCalls[1].tst, staleTst, 'stale tst should be substituted for activity');
    assert.notEqual(visitCalls[1].point.tst, staleTst, 'stale tst should be substituted for visit');
    assert.ok(activityCalls[1].tst > staleTst, 'substituted tst should be a recent server timestamp');

    // Third request: new tst — passed through unchanged
    const newTst = 1711040400;
    await request(staleTstApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.997, lon: -117.926, tst: newTst, vel: 0 });

    assert.equal(activityCalls[2].tst, newTst, 'new tst should be passed through');
    assert.equal(visitCalls[2].point.tst, newTst, 'new tst should be passed through for visit');
  });

  it('stores original tst in database even when substituted', async () => {
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const { store, db } = createTestStore();
    const staleTstApp = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      store,
      activity,
    });

    const staleTst = 1711050000;

    // Send twice with the same tst
    await request(staleTstApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.996, lon: -117.930, tst: staleTst, vel: 0 });
    await request(staleTstApp)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 33.996, lon: -117.930, tst: staleTst, vel: 0 });

    const rows = db.prepare('SELECT tst FROM location_entries ORDER BY id').all();
    assert.equal(rows[0].tst, staleTst, 'first entry stores original tst');
    assert.equal(rows[1].tst, staleTst, 'second entry stores original tst (not substituted)');
  });
});
