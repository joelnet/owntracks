import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(import.meta.dirname, '../logs');

function getLogPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${today}.log`);
}

function write(level, message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level}] ${message}`;
  fs.appendFileSync(getLogPath(), line + '\n', 'utf-8');
  (level === 'ERROR' ? console.error : console.log)(line);
}

export function info(message) {
  write('INFO', message);
}

export function error(message) {
  write('ERROR', message);
}
