// Интеграционный смоук: мост + внешний MCP-сервер одновременно.
// Поднимает отдельный мост (свой порт/DATA_DIR), в его конфиг прописывает
// внешний stdio-MCP-сервер, проверяет /api/mcp/status, /api/tools с external,
// /mcp tools/list с внешними инструментами и вызов внешнего через MCP.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-mcp-int-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const PORT = 18444;

// Фейковый внешний MCP-сервер на stdio.
const fakeServer = path.join(tmp, 'external-mcp.mjs');
fs.writeFileSync(fakeServer, `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'external-test', version: '9.9.9' },
      } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'ping_external', description: 'Проверка внешнего сервера', inputSchema: { type: 'object', properties: {} } },
      ] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'external says: pong' }],
      } }) + '\\n');
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } }) + '\\n');
    }
  }
});
`, 'utf8');

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

function req(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
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
      const r = await req('GET', '/api/health');
      if (r.status === 200) return;
    } catch { /* ok */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('мост не поднялся');
}

// Конфиг пишем ДО старта моста.
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  token: 'test-token-integration',
  workspaceRoot: ws,
  port: PORT,
  autoOpen: false,
  allowCommands: false,
  allowNetwork: false,
  extraRoots: [],
  mcpServers: [
    { name: 'ext', transport: 'stdio', command: process.execPath, args: [fakeServer] },
  ],
}, null, 2), 'utf8');

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
  const token = 'test-token-integration';
  ok('мост поднялся с внешним MCP-сервером в конфиге');

  // Ждём, пока внешний сервер подключится (startAll асинхронный).
  let status;
  for (let i = 0; i < 50; i++) {
    const r = await req('GET', '/api/mcp/status?token=' + token);
    status = JSON.parse(r.body).servers;
    if (status.some((s) => s.ready)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ext = status.find((s) => s.name === 'ext');
  assert.ok(ext, 'внешний сервер должен быть в статусе');
  assert.ok(ext.alive, 'внешний сервер должен быть жив');
  assert.equal(ext.tools, 1);
  assert.equal(ext.serverInfo.name, 'external-test');
  ok('GET /api/mcp/status → внешний сервер жив, 1 инструмент, serverInfo');

  // /api/tools теперь отдаёт external
  const toolsResp = JSON.parse((await req('GET', '/api/tools?token=' + token)).body);
  assert.ok(Array.isArray(toolsResp.external));
  assert.equal(toolsResp.external.length, 1);
  assert.equal(toolsResp.external[0].name, 'ext__ping_external');
  ok('GET /api/tools → external: ext__ping_external');

  // /mcp tools/list включает внешний инструмент
  const list = JSON.parse((await req('POST', '/mcp', {
    token,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  })).body);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('read_file'), 'родной инструмент на месте');
  assert.ok(names.includes('ext__ping_external'), 'внешний инструмент в списке');
  ok('POST /mcp tools/list → ' + names.length + ' инструментов, включая внешний');

  // /mcp tools/call внешнего инструмента
  const call = JSON.parse((await req('POST', '/mcp', {
    token,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ext__ping_external', arguments: {} } },
  })).body);
  assert.equal(call.result.isError, false);
  assert.ok(call.result.content[0].text.includes('external says: pong'));
  ok('POST /mcp tools/call ext__ping_external → ответ внешнего сервера');

  // Через dsbridge-транспорт тоже доступно
  const viaApi = JSON.parse((await req('POST', '/api/tool?token=' + token, {
    token,
    body: { tool: 'ext__ping_external', args: {} },
  })).body);
  assert.equal(viaApi.ok, true);
  assert.ok(JSON.stringify(viaApi.result).includes('external says: pong'));
  ok('POST /api/tool ext__ping_external → тоже работает (dsbridge-транспорт)');

  console.log('\nMCP integration smoke: ' + passed + ' ok');
} catch (e) {
  exitCode = 1;
  console.error('\nПРОВАЛ:', e.message);
  console.error(e.stack);
  console.error('--- лог моста (полный) ---');
  console.error(log);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(exitCode);
