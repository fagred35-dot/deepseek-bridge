// Смоук MCP-клиента. Никаких реальных внешних серверов — поднимаем два
// фейковых: stdio (Node-процесс) и http (локальный сервер), и проверяем, что
// мост их подключает, видит инструменты, проксирует вызовы и знает статус.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpClientManager } from '../src/mcp-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-mcpcli-'));

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

// ---------- фейковый stdio-сервер ----------
const fakeStdio = path.join(tmp, 'fake-stdio.mjs');
fs.writeFileSync(fakeStdio, `
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
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-stdio', version: '1.0.0' },
      } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: 'Эхо-инструмент', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'add', description: 'Сложить два числа', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
      ] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      let result;
      if (msg.params.name === 'echo') result = { content: [{ type: 'text', text: 'echo: ' + (msg.params.arguments.text || '') }] };
      else if (msg.params.name === 'add') result = { content: [{ type: 'text', text: String((msg.params.arguments.a || 0) + (msg.params.arguments.b || 0)) }] };
      else result = { content: [{ type: 'text', text: 'unknown' }], isError: true };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } }) + '\\n');
    }
  }
});
`, 'utf8');

// ---------- фейковый http-сервер ----------
const httpPort = 18999;
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    res.setHeader('Content-Type', 'application/json');
    let out;
    if (msg.method === 'initialize') {
      out = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-http', version: '2.0.0' } } };
    } else if (msg.method === 'tools/list') {
      out = { jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'screenshot', description: 'Снять экран', inputSchema: { type: 'object', properties: {} } },
      ] } };
    } else if (msg.method === 'tools/call') {
      out = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'http-ok:' + msg.params.name }] } };
    } else if (msg.id !== undefined) {
      out = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } };
    } else {
      out = null;
    }
    res.end(out ? JSON.stringify(out) : '');
  });
});
await new Promise((r) => httpServer.listen(httpPort, '127.0.0.1', r));

let exitCode = 0;
try {
  const manager = new McpClientManager([
    { name: 'fake', transport: 'stdio', command: process.execPath, args: [fakeStdio] },
    { name: 'remote', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp` },
    { name: 'disabled', transport: 'stdio', command: 'nope', args: [], enabled: false },
  ]);
  await manager.startAll();
  ok('менеджер стартовал оба сервера, отключённый пропущен');

  const status = manager.status();
  assert.equal(status.length, 2, 'отключённый сервер не должен попадать в статус');
  const fake = status.find((s) => s.name === 'fake');
  assert.ok(fake.alive);
  assert.equal(fake.tools, 2);
  assert.equal(fake.serverInfo.name, 'fake-stdio');
  ok('stdio-сервер: alive, 2 инструмента, serverInfo прочитан');

  const remote = status.find((s) => s.name === 'remote');
  assert.ok(remote.alive);
  assert.equal(remote.tools, 1);
  assert.equal(remote.transport, 'http');
  ok('http-сервер: alive, 1 инструмент, транспорт http');

  const tools = manager.proxiedTools();
  assert.equal(tools.length, 3);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('fake__echo'));
  assert.ok(names.includes('fake__add'));
  assert.ok(names.includes('remote__screenshot'));
  ok('proxiedTools: имена с префиксом сервера');

  const echo = tools.find((t) => t.name === 'fake__echo');
  assert.equal(echo._meta.source, 'mcp');
  assert.equal(echo._meta.server, 'fake');
  assert.equal(echo._meta.originalName, 'echo');
  ok('proxiedTools: _meta.source/server/originalName');

  const r1 = await manager.call('fake__echo', { text: 'привет' });
  assert.ok(r1.content[0].text.includes('echo: привет'));
  ok('call fake__echo → проксирован на stdio-сервер');

  const r2 = await manager.call('fake__add', { a: 2, b: 3 });
  assert.ok(r2.content[0].text.includes('5'));
  ok('call fake__add → вернул 5');

  const r3 = await manager.call('remote__screenshot', {});
  assert.ok(r3.content[0].text.includes('http-ok:screenshot'));
  ok('call remote__screenshot → проксирован на http-сервер');

  await assert.rejects(() => manager.call('нет__такого', {}), /не найден/i);
  ok('call неизвестного внешнего инструмента → ошибка');

  manager.stopAll();
  ok('stopAll останавливает клиентов');

  console.log('\nMCP client smoke: ' + passed + ' ok');
} catch (e) {
  exitCode = 1;
  console.error('\nПРОВАЛ:', e.message);
  console.error(e.stack);
} finally {
  httpServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(exitCode);
