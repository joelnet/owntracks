import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { appendEntry } from './lib/store.js';

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

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

    if (!safeEqual(user, username) || !safeEqual(pass, password)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate body
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
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
