// Смоук GUI-инструментов: поднимает ОТДЕЛЬНЫЙ мост с allowInput=true,
// запускает блокнот и проверяет полный цикл — состояние, чтение, запись,
// клавиши. Блокнот закрывается в конце; ввод не трогает реальный курсор,
// потому что все действия идут в background-режиме.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-gui-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const PORT = 18447;

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['X-Bridge-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({ raw: buf }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(t = 10000) {
  const d = Date.now() + t;
  while (Date.now() < d) {
    try {
      const r = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res(b)); }).on('error', rej); });
      if (r) return;
    } catch { /* ждём */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('мост не поднялся');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, DSBRIDGE_PORT: String(PORT), DSBRIDGE_DATA: tmp, DSBRIDGE_WORKSPACE: ws, DSBRIDGE_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (c) => (log += c));
child.stderr.on('data', (c) => (log += c));

let exitCode = 0;
let notepadPid = null;
try {
  await waitHealth();
  const token = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).token;
  const tool = (name, args) => req('POST', '/api/tool', { tool: name, args }, token);

  // Флаг по умолчанию выключен — инструмент должен честно сказать EDISABLED.
  const off = await tool('gui_state', { process: 'notepad' });
  assert.equal(off.ok, false);
  assert.equal(off.error.code, 'EDISABLED');
  ok('без флага «Управление вводом» → EDISABLED');

  // Включаем флаг и проверяем, что он подхватился.
  await req('POST', '/api/settings', { allowInput: true }, token);
  const health = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res(JSON.parse(b))); }).on('error', rej); });
  assert.equal(health.allowInput, true);
  ok('флаг «Управление вводом» включается и виден в /api/health');

  // Запускаем блокнот.
  const { spawn: spawnChild } = await import('node:child_process');
  const np = spawnChild('notepad.exe', [], { detached: true, stdio: 'ignore' });
  notepadPid = np.pid;
  np.unref();
  await sleep(2500);

  // Состояние окна.
  const st = await tool('gui_state', { process: 'notepad' });
  assert.equal(st.ok, true, JSON.stringify(st).slice(0, 300));
  assert.ok(st.result.handle > 0);
  assert.ok(st.result.rect.width > 0 && st.result.rect.height > 0);
  ok('gui_state: окно блокнота найдено, rect непустой');

  // Чтение: у блокнота есть Edit-контрол.
  const rd = await tool('gui_read', { process: 'notepad' });
  assert.equal(rd.ok, true);
  assert.ok(Array.isArray(rd.result.childClasses));
  assert.ok(rd.result.childClasses.some((c) => /edit/i.test(c)), JSON.stringify(rd.result.childClasses));
  ok('gui_read: у окна найден дочерний Edit-контрол');

  // Запись в поле через семантику (background, фокус не трогаем).
  const set1 = await tool('gui_set', { process: 'notepad', text: 'GUI SMOKE TEST' });
  assert.equal(set1.ok, true, JSON.stringify(set1).slice(0, 200));
  assert.equal(set1.result.applied, true);
  const rd2 = await tool('gui_read', { process: 'notepad' });
  assert.equal(rd2.result.text, 'GUI SMOKE TEST');
  ok('gui_set + gui_read: текст записан и прочитан обратно');

  // Ввод текста через background (PostMessage в Edit).
  await tool('gui_set', { process: 'notepad', text: '' });
  const t1 = await tool('gui_type', { process: 'notepad', text: 'typed-by-agent', mode: 'background' });
  assert.equal(t1.ok, true, JSON.stringify(t1).slice(0, 200));
  await sleep(300);
  const rd3 = await tool('gui_read', { process: 'notepad' });
  assert.ok(String(rd3.result.text).includes('typed-by-agent'), rd3.result.text);
  ok('gui_type background: текст дошёл до поля');

  // Многострочность и кириллица.
  const multi = await tool('gui_set', { process: 'notepad', text: 'Строка 1\nСтрока 2' });
  assert.equal(multi.ok, true);
  const rd4 = await tool('gui_read', { process: 'notepad' });
  assert.ok(String(rd4.result.text).includes('Строка 1'), rd4.result.text);
  assert.ok(String(rd4.result.text).includes('Строка 2'), rd4.result.text);
  ok('gui_set: кириллица и переносы строк сохранены');

  console.log('\nGUI smoke: ' + passed + ' ok');
} catch (e) {
  exitCode = 1;
  console.error('\nПРОВАЛ:', e.message);
  console.error(e.stack);
  console.error('--- лог моста ---');
  console.error(log.slice(-2000));
} finally {
  // Закрываем блокнот, который сами запустили.
  try {
    const { execSync } = await import('node:child_process');
    if (notepadPid) execSync(`taskkill /PID ${notepadPid} /T /F`, { stdio: 'ignore' });
  } catch { /* уже закрыт */ }
  child.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(exitCode);
