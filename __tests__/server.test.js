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
});
