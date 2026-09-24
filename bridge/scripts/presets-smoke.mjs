// Смоук персонажей и скиллов: инструменты моста + MCP prompts.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-presets-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const PORT = 18446;

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
  const mcp = (method, params, id = 1) => req('POST', '/mcp', { jsonrpc: '2.0', id, method, params }, token);

  // ---- персонажи ----
  const p0 = await tool('persona_list', {});
  assert.equal(p0.ok, true);
  assert.equal(p0.result.personas.length, 0);
  ok('persona_list пуст на старте');

  const ps = await tool('persona_set', { name: 'Python-разработчик', text: 'Ты senior Python-разработчик.', description: 'Строгий код' });
  assert.equal(ps.result.stored, true);
  ok('persona_set сохраняет');

  const pl = await tool('persona_list', {});
  assert.equal(pl.result.personas.length, 1);
  assert.equal(pl.result.personas[0].name, 'Python-разработчик');
  ok('persona_list показывает персонажа');

  const pg = await tool('persona_get', { name: 'Python-разработчик' });
  assert.ok(pg.result.text.includes('senior Python'));
  ok('persona_get отдаёт текст');

  const pdup = await tool('persona_set', { name: 'Python-разработчик', text: 'Обновлённый текст.' });
  const pg2 = await tool('persona_get', { name: 'Python-разработчик' });
  assert.equal(pg2.result.text, 'Обновлённый текст.');
  ok('persona_set перезаписывает');

  const pbad = await tool('persona_set', { name: 'плохое/имя', text: 'x' });
  assert.equal(pbad.ok, false);
  assert.equal(pbad.error.code, 'EARGS');
  ok('persona_set: плохое имя → EARGS');

  const pempty = await tool('persona_set', { name: 'ok', text: '   ' });
  assert.equal(pempty.error.code, 'EARGS');
  ok('persona_set: пустой text → EARGS');

  // ---- скиллы ----
  const ss = await tool('skill_set', {
    name: 'react-component',
    text: 'Создай компонент {{компонент}} в файле {{файл}}.',
    description: 'Генерация React-компонента',
    arguments: [{ name: 'компонент', description: 'Имя', required: true }, { name: 'файл', required: true }],
  });
  assert.equal(ss.result.stored, true);
  assert.equal(ss.result.arguments, 2);
  ok('skill_set сохраняет с аргументами');

  const sl = await tool('skill_list', {});
  assert.equal(sl.result.skills.length, 1);
  assert.equal(sl.result.skills[0].arguments.length, 2);
  ok('skill_list отдаёт скилл с аргументами');

  const sr = await tool('skill_render', { name: 'react-component', values: { компонент: 'Button', файл: 'src/Button.jsx' } });
  assert.equal(sr.result.text, 'Создай компонент Button в файле src/Button.jsx.');
  ok('skill_render подставляет значения');

  const srMissing = await tool('skill_render', { name: 'react-component', values: { компонент: 'Button' } });
  assert.ok(srMissing.result.text.includes('{{файл}}'));
  ok('skill_render: незаполненный плейсхолдер остаётся как есть');

  // ---- MCP prompts ----
  const init = await mcp('initialize', {});
  assert.ok(init.result.capabilities.prompts, 'capability prompts должна быть объявлена');
  ok('MCP initialize объявляет capability prompts');

  const plist = await mcp('prompts/list', {}, 2);
  assert.equal(plist.result.prompts.length, 1);
  assert.equal(plist.result.prompts[0].name, 'react-component');
  assert.equal(plist.result.prompts[0].arguments.length, 2);
  ok('MCP prompts/list отдаёт скиллы как промпты');

  const pget = await mcp('prompts/get', { name: 'react-component', arguments: { компонент: 'Card', файл: 'src/Card.jsx' } }, 3);
  assert.ok(pget.result.messages[0].content.text.includes('Card'));
  assert.ok(pget.result.messages[0].content.text.includes('src/Card.jsx'));
  ok('MCP prompts/get подставляет аргументы');

  const pgetNo = await mcp('prompts/get', { name: 'нет-такого' }, 4);
  assert.ok(pgetNo.error);
  assert.equal(pgetNo.error.code, -32602);
  ok('MCP prompts/get: неизвестный → -32602');

  // ---- удаление ----
  const pd = await tool('persona_delete', { name: 'Python-разработчик' });
  assert.equal(pd.result.deleted, true);
  const sd = await tool('skill_delete', { name: 'react-component' });
  assert.equal(sd.result.deleted, true);
  const pl2 = await tool('persona_list', {});
  const sl2 = await tool('skill_list', {});
  assert.equal(pl2.result.personas.length, 0);
  assert.equal(sl2.result.skills.length, 0);
  ok('удаление персонажа и скилла');

  const delNo = await tool('persona_delete', { name: 'нет' });
  assert.equal(delNo.error.code, 'ENOENT');
  ok('persona_delete несуществующего → ENOENT');

  console.log('\nPresets smoke: ' + passed + ' ok');
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
