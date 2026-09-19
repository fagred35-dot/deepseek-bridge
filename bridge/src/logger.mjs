import fs from 'node:fs';
import { AUDIT_PATH } from './config.mjs';

const subscribers = new Set();

export function subscribe(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function emit(event) {
  const ev = { ts: new Date().toISOString(), ...event };
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(ev) + '\n');
  } catch {
    // audit-log недоступен — не роняем мост
  }
  for (const res of subscribers) {
    try {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      subscribers.delete(res);
    }
  }
  return ev;
}

export function log(level, message, extra = {}) {
  const ev = emit({ level, message, ...extra });
  const tag = String(level).toUpperCase().padEnd(5);
  const tail = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  console.log(`[${ev.ts}] ${tag} ${message}${tail}`);
}
