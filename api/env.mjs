import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['.env', '.env.local']) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export const env = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
export const flag = (key) => /^(1|true|yes|on)$/i.test(env(key, ''));
export const num = (key, fallback) => {
  const n = Number(env(key, ''));
  return Number.isFinite(n) && env(key, '') !== '' ? n : fallback;
};
export const PROD = env('NODE_ENV') === 'production';
