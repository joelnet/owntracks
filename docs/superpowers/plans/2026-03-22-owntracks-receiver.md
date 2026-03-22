# OwnTracks Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js Express server that receives OwnTracks location pings via HTTP POST and stores them as daily JSONL files.

**Architecture:** Single Express server with one POST endpoint (`/pub`). HTTP Basic Auth validates credentials from `.env`. A thin storage module appends JSON lines to daily files in `data/`. Two source files total: `server.js` and `lib/store.js`.

**Tech Stack:** Node.js (ESM), Express, dotenv, node:test + supertest for testing

**Spec:** `docs/superpowers/specs/2026-03-22-owntracks-receiver-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `lib/store.js` | Append JSON entries to daily JSONL files in `data/` |
| `server.js` | Express app: auth middleware, `POST /pub` handler, starts listening |
| `test/store.test.js` | Tests for JSONL storage module |
| `test/server.test.js` | Integration tests for HTTP endpoint |
| `.env.example` | Template showing required env vars |
| `.gitignore` | Ignore `data/`, `.env`, `node_modules/` |

---

### Task 1: Project Setup

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
data/
data-test*/
.env
```

- [ ] **Step 2: Create `.env.example`**

```env
PORT=3000
OWNTRACKS_USERNAME=joel
OWNTRACKS_PASSWORD=your-secret-password
```

- [ ] **Step 3: Create `.env` from example**

Copy `.env.example` to `.env` and set real values. This file is gitignored.

- [ ] **Step 4: Install dependencies**

Run: `npm install express dotenv`
Run: `npm install --save-dev supertest`

- [ ] **Step 5: Update `package.json`**

Fix the package name (currently `"owncloud"`) and add scripts:

```json
{
  "name": "owntracks-journal",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example package.json package-lock.json
git commit -m "chore: project setup with dependencies and config"
```

---

### Task 2: JSONL Storage Module

**Files:**
- Create: `test/store.test.js`
- Create: `lib/store.js`

- [ ] **Step 1: Write failing tests for store module**

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEntry, getDataDir } from '../lib/store.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../data-test');

describe('store', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('creates a JSONL file named by date', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    assert.ok(fs.existsSync(filePath), 'JSONL file should exist');
  });

  it('writes valid JSON on each line', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const line = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.lat, 33.99);
    assert.equal(parsed.lon, -117.87);
    assert.equal(parsed.type, 'location');
  });

  it('appends multiple entries as separate lines', () => {
    const entry1 = { lat: 33.99, lon: -117.87, type: 'location' };
    const entry2 = { lat: 34.05, lon: -118.24, type: 'location' };
    appendEntry(entry1, TEST_DATA_DIR);
    appendEntry(entry2, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).lat, 33.99);
    assert.equal(JSON.parse(lines[1]).lat, 34.05);
  });

  it('creates data directory if it does not exist', () => {
    const nested = path.join(TEST_DATA_DIR, 'nested');
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, nested);
    assert.ok(fs.existsSync(nested), 'directory should be created');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib/store.js` does not exist yet

- [ ] **Step 3: Implement `lib/store.js`**

```js
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.join(import.meta.dirname, '../data');

export function getDataDir() {
  return DEFAULT_DATA_DIR;
}

export function appendEntry(entry, dataDir = DEFAULT_DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dataDir, `${today}.jsonl`);
  const line = JSON.stringify(entry) + '\n';

  fs.appendFileSync(filePath, line, 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat: add JSONL storage module with tests"
```

---

### Task 3: Express Server with Auth and POST /pub

**Files:**
- Create: `test/server.test.js`
- Create: `server.js`

- [ ] **Step 1: Write failing tests for the server**

```js
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server.js';

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createApp` is not exported from `server.js`

- [ ] **Step 3: Implement `server.js`**

```js
import 'dotenv/config';
import express from 'express';
import { appendEntry } from './lib/store.js';

export function createApp({ username, password, dataDir } = {}) {
  const app = express();

  app.use(express.json());

  app.post('/pub', (req, res) => {
    // Validate Basic Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);

    if (user !== username || pass !== password) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate body
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Bad request' });
    }

    // Build entry
    const { _type, ...fields } = req.body;
    const device = req.headers['x-limit-d'] || 'phone';

    const entry = {
      username: user,
      device,
      ...fields,
      type: _type || 'unknown',
      received_at: new Date().toISOString(),
    };

    appendEntry(entry, dataDir);

    return res.status(200).json([]);
  });

  return app;
}

// Start server when run directly (not imported by tests)
const isDirectRun = process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const port = process.env.PORT || 3000;
  const username = process.env.OWNTRACKS_USERNAME;
  const password = process.env.OWNTRACKS_PASSWORD;

  if (!username || !password) {
    console.error('OWNTRACKS_USERNAME and OWNTRACKS_PASSWORD must be set in .env');
    process.exit(1);
  }

  const app = createApp({ username, password });
  app.listen(port, () => {
    console.log(`OwnTracks receiver listening on port ${port}`);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 6 server tests PASS, all 4 store tests PASS (10 total)

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: add Express server with Basic Auth and POST /pub endpoint"
```

---

### Task 4: End-to-End Smoke Test

**Files:** none new — manual verification

- [ ] **Step 1: Create `.env` if not already done**

```bash
cp .env.example .env
# Edit .env with real credentials
```

- [ ] **Step 2: Start the server**

Run: `npm start`
Expected: `OwnTracks receiver listening on port 3000`

- [ ] **Step 3: Send a test request with curl**

```bash
curl -s -X POST http://localhost:3000/pub \
  -H "Content-Type: application/json" \
  -H "X-Limit-D: testphone" \
  -u "joel:your-password" \
  -d '{"_type":"location","lat":33.99,"lon":-117.87,"tst":1711036800,"acc":15,"batt":85,"tid":"JL"}'
```

Expected: `[]`

- [ ] **Step 4: Verify the JSONL file was created**

```bash
cat data/$(date +%Y-%m-%d).jsonl
```

Expected: One JSON line with all fields including `username`, `device`, `type`, `received_at`

- [ ] **Step 5: Test auth rejection**

```bash
curl -s -X POST http://localhost:3000/pub \
  -H "Content-Type: application/json" \
  -u "wrong:creds" \
  -d '{"_type":"location","lat":33.99,"lon":-117.87}'
```

Expected: `401` status with `{"error":"Unauthorized"}`

- [ ] **Step 6: Final commit if any unstaged changes remain**

```bash
git status
# Only add specific files that should be tracked — never use git add -A with .env present
```
