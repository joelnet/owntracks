import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.join(import.meta.dirname, '../../data');

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
