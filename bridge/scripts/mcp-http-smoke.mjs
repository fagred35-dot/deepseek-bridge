// HTTP-смоук MCP-эндпоинта. Поднимает ОТДЕЛЬНЫЙ экземпляр моста
// (свой порт, свой DATA_DIR, своя рабочая папка) — текущий мост не трогает.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// fileURLToPath, а не url.pathname: в пути есть кириллица, и pathname
// отдаёт её percent-encoded — spawn по такому пути падает с MODULE_NOT_FOUND.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-mcp-http-'));
const ws = path.join(dataDir, 'ws');
fs.mkdirSync(ws, { recursive: true });
const PORT = 18443;

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

function req(method, urlPath, { body, token, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (origin) headers['Origin'] = origin;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return JSON.parse(r.body);
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('мост не поднялся');
}

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    DSBRIDGE_PORT: String(PORT),
    DSBRIDGE_DATA: dataDir,
    DSBRIDGE_WORKSPACE: ws,
    DSBRIDGE_NO_OPEN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (c) => (childLog += c));
child.stderr.on('data', (c) => (childLog += c));

let exitCode = 0;
try {
  await waitHealth();
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const token = cfg.token;
  assert.ok(token && token.length > 10);
  ok('отдельный мост поднялся, токен прочитан из своего config.json');

  const noAuth = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
  assert.equal(noAuth.status, 401);
  assert.ok(String(noAuth.headers['www-authenticate'] || '').includes('Bearer'));
  ok('POST /mcp без токена → 401 + WWW-Authenticate: Bearer');

  const badOrigin = await req('POST', '/mcp', {
    token,
    origin: 'https://evil.example.com',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  });
  assert.equal(badOrigin.status, 403);
  ok('чужой Origin → 403 (защита от DNS rebinding)');

  const get = await req('GET', '/mcp', { token });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  ok('GET /mcp → 405 Allow: POST');

  const init = await req('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(init.status, 200);
  const initJson = JSON.parse(init.body);
  assert.equal(initJson.result.serverInfo.name, 'dsbridge');
  ok('initialize → serverInfo dsbridge');

  const list = await req('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
  const listJson = JSON.parse(list.body);
  assert.ok(listJson.result.tools.length >= 40);
  ok('tools/list → ' + listJson.result.tools.length + ' инструментов');

  fs.writeFileSync(path.join(ws, 'привет.txt'), 'привет через MCP', 'utf8');
  const call = await req('POST', '/mcp', {
    token,
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'привет.txt' } } },
  });
  const callJson = JSON.parse(call.body);
  assert.equal(callJson.result.isError, false);
  assert.ok(callJson.result.content[0].text.includes('привет через MCP'));
  ok('tools/call read_file → содержимое файла');

  const batch = await req('POST', '/mcp', {
    token,
    body: [
      { jsonrpc: '2.0', id: 10, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
    ],
  });
  const batchJson = JSON.parse(batch.body);
  assert.ok(Array.isArray(batchJson));
  assert.equal(batchJson.length, 2, 'уведомление не должно давать ответ');
  ok('batch: 3 сообщения (одно — уведомление) → 2 ответа');

  const notifOnly = await req('POST', '/mcp', {
    token,
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(notifOnly.status, 202);
  assert.equal(notifOnly.body, '');
  ok('только уведомление → 202 без тела');

  const badJson = await req('POST', '/mcp', { token, body: '{не json' });
  const badJsonObj = JSON.parse(badJson.body);
  assert.equal(badJsonObj.error.code, -32700);
  ok('битый JSON → -32700 Parse error');

  console.log('\nMCP HTTP smoke: ' + passed + ' ok');
} catch (e) {
  exitCode = 1;
  console.error('\nПРОВАЛ:', e.message);
  console.error('--- лог моста ---');
  console.error(childLog.slice(-2000));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(exitCode);
