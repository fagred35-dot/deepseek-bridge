// Смоук инструмента python. Поднимает ОТДЕЛЬНЫЙ мост (свой порт/DATA_DIR),
// проверяет: простой скрипт, stdout/stderr, аргументы, stdin, exit code, ошибку.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-py-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const PORT = 18445;

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['X-Bridge-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf || '{}')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (res) => {
          let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
        }).on('error', reject);
      });
      if (r) return;
    } catch { /* не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('мост не поднялся');
}

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, DSBRIDGE_PORT: String(PORT), DSBRIDGE_DATA: tmp, DSBRIDGE_WORKSPACE: ws, DSBRIDGE_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (c) => (log += c));
child.stderr.on('data', (c) => (log += c));

let exitCode = 0;
try {
  await waitHealth();
  const token = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).token;
  const tool = (name, args) => req('POST', '/api/tool', { tool: name, args }, token);

  // 1. Простой скрипт
  const r1 = await tool('python', { code: 'print("привет из python")' });
  assert.equal(r1.ok, true, JSON.stringify(r1).slice(0, 300));
  assert.equal(r1.result.exitCode, 0);
  assert.ok(r1.result.stdout.includes('привет из python'));
  assert.ok(r1.result.python.includes('python'));
  ok('простой скрипт: stdout получен, exitCode 0');

  // 2. stderr и код возврата
  const r2 = await tool('python', { code: 'import sys; sys.stderr.write("ош"); sys.exit(3)' });
  assert.equal(r2.result.exitCode, 3);
  assert.ok(r2.result.stderr.includes('ош'));
  ok('stderr и ненулевой exitCode');

  // 3. Аргументы
  const r3 = await tool('python', { code: 'import sys; print(sys.argv[1:])', args: ['a', 'b'] });
  assert.ok(r3.result.stdout.includes("['a', 'b']"), r3.result.stdout);
  ok('аргументы доходят через sys.argv');

  // 4. stdin
  const r4 = await tool('python', { code: 'print(input().upper())', stdin: 'тихо' });
  assert.ok(r4.result.stdout.includes('ТИХО'), r4.result.stdout);
  ok('stdin подаётся в скрипт');

  // 5. Работа с файлами в рабочей папке
  const r5 = await tool('python', { code: 'open("out.txt","w").write("ok"); print("записано")' });
  assert.equal(r5.result.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(ws, 'out.txt'), 'utf8'), 'ok');
  ok('скрипт пишет файл в рабочей папке');

  // 6. Ошибка в коде — stderr, ненулевой код, но не EBRIDGE
  const r6 = await tool('python', { code: 'raise ValueError("бум")' });
  assert.equal(r6.ok, true);
  assert.notEqual(r6.result.exitCode, 0);
  assert.ok(r6.result.stderr.includes('ValueError'));
  ok('исключение в коде → stderr с трассировкой');

  // 7. Пустой code
  const r7 = await tool('python', { code: '   ' });
  assert.equal(r7.ok, false);
  assert.equal(r7.error.code, 'EARGS');
  ok('пустой code → EARGS');

  console.log('\nPython smoke: ' + passed + ' ok');
} catch (e) {
  exitCode = 1;
  console.error('\nПРОВАЛ:', e.message);
  console.error(e.stack);
  console.error('--- лог моста ---');
  console.error(log.slice(-2000));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(exitCode);
