// Ручной смоук MCP-ядра: без HTTP и без перезапуска моста.
// Гоняет handleRpc напрямую — initialize, tools/list, tools/call, ошибки.
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { handleRpc, listMcpTools, MCP_PROTOCOL_VERSION } from '../src/mcp.mjs';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-mcp-'));
const cfg = { workspaceRoot: ws, extraRoots: [], allowCommands: false, allowNetwork: false };

let passed = 0;
function ok(name) { passed++; console.log('ok', passed, '-', name); }

// initialize
const init = await handleRpc(cfg, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
assert.equal(init.result.serverInfo.name, 'dsbridge');
assert.ok(init.result.capabilities.tools);
ok('initialize отдаёт protocolVersion и serverInfo');

// notifications/initialized — ответа быть не должно
const notif = await handleRpc(cfg, { jsonrpc: '2.0', method: 'notifications/initialized' });
assert.equal(notif, null);
ok('notifications/initialized молчит (null)');

// tools/list
const list = await handleRpc(cfg, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
assert.ok(Array.isArray(list.result.tools));
assert.ok(list.result.tools.length >= 40);
const names = list.result.tools.map((t) => t.name);
assert.ok(names.includes('read_file'));
assert.ok(names.includes('run_command'));
for (const t of list.result.tools) {
  assert.equal(typeof t.name, 'string');
  assert.equal(t.inputSchema.type, 'object');
}
ok('tools/list отдаёт все инструменты с inputSchema');

// inputSchema: типы выводятся из описаний
const readFile = list.result.tools.find((t) => t.name === 'read_file');
assert.equal(readFile.inputSchema.properties.path.type, 'string');
const listDir = list.result.tools.find((t) => t.name === 'list_dir');
assert.equal(listDir.inputSchema.properties.recursive.type, 'boolean');
assert.equal(listDir.inputSchema.properties.maxDepth.type, 'number');
ok('типы параметров выводятся из описаний (string/boolean/number)');

// _meta.toolSet
assert.equal(listDir._meta.toolSet, 'files');
ok('_meta.toolSet проставлен');

// фильтр по набору
const onlyFiles = await handleRpc(cfg, {
  jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { toolSet: 'files' } },
});
assert.ok(onlyFiles.result.tools.every((t) => t._meta.toolSet === 'files'));
assert.ok(onlyFiles.result.tools.length < list.result.tools.length);
ok('tools/list умеет фильтровать по toolSet');

// tools/call: успех
fs.writeFileSync(path.join(ws, 'hello.txt'), 'привет из MCP', 'utf8');
const call = await handleRpc(cfg, {
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'read_file', arguments: { path: 'hello.txt' } },
});
assert.equal(call.result.isError, false);
assert.ok(call.result.content[0].text.includes('привет из MCP'));
assert.ok(call.result.structuredContent);
ok('tools/call read_file возвращает content + structuredContent');

// tools/call: ошибка инструмента — это не ошибка JSON-RPC
const bad = await handleRpc(cfg, {
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'read_file', arguments: { path: 'нет-такого.txt' } },
});
assert.ok(!bad.error, 'ошибка инструмента не должна быть JSON-RPC error');
assert.equal(bad.result.isError, true);
assert.ok(bad.result.content[0].text.includes('ENOENT'));
ok('ошибка инструмента → isError:true, а не JSON-RPC error');

// неизвестный метод
const unknown = await handleRpc(cfg, { jsonrpc: '2.0', id: 6, method: 'нет/такого', params: {} });
assert.equal(unknown.error.code, -32601);
ok('неизвестный метод → -32601');

// неизвестный инструмент
const noTool = await handleRpc(cfg, {
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'нет_такого', arguments: {} },
});
assert.equal(noTool.result.isError, true);
assert.ok(noTool.result.content[0].text.includes('ENOTOOL'));
ok('неизвестный инструмент → isError:true, ENOTOOL');

// ping
const ping = await handleRpc(cfg, { jsonrpc: '2.0', id: 8, method: 'ping' });
assert.deepEqual(ping.result, {});
ok('ping → {}');

console.log('\nMCP smoke: ' + passed + ' ok');
fs.rmSync(ws, { recursive: true, force: true });
