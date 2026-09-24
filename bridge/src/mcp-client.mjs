// MCP-клиент: мост подключается к ВНЕШНИМ MCP-серверам и проксирует их
// инструменты в общий список — рядом со своими 40.
//
// Поддерживаем два транспорта, которых хватает почти всем серверам:
//  - stdio   — запускаем процесс сервера (npx ...), общаемся построчным JSON-RPC;
//  - http    — Streamable HTTP, POST JSON-RPC на URL (для удалённых серверов).
//
// Зачем: computer-use-mcp и подобные не надо встраивать в мост — они живут
// отдельными процессами, а мост видит их инструменты через tools/list и умеет
// вызывать через tools/call. Так и работает связка «dsbridge + MCP как
// первоклассный гражданин»: один реестр, два транспорта, внешние серверы — плагины.

import { spawn } from 'node:child_process';
import { log } from './logger.mjs';

const CLIENT_NAME = 'dsbridge';
const CLIENT_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 60000;

// Один подключённый внешний сервер. Держит транспорт, список инструментов и
// счётчик id для JSON-RPC.
export class McpClient {
  constructor({ name, transport, command, args, url, env, cwd, headers }) {
    this.name = name;
    this.transport = transport; // 'stdio' | 'http'
    this.command = command;
    this.args = args || [];
    this.url = url;
    this.env = env || {};
    this.cwd = cwd;
    this.headers = headers || {};
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.tools = [];
    // alive — процесс жив; ready — рукопожатие завершено и список инструментов
    // получен. Разделяем: сразу после spawn процесс уже жив, но звать его
    // инструменты ещё нельзя (initialize и tools/list ещё в процессе).
    this.alive = false;
    this.ready = false;
    this.lastError = null;
  }

  // Запуск и рукопожатие. Ошибку не бросаем — записываем в lastError, чтобы
  // один упавший сервер не валил остальные.
  async start() {
    try {
      if (this.transport === 'stdio') await this.startStdio();
      else if (this.transport === 'http') await this.startHttp();
      else throw new Error('Неизвестный транспорт: ' + this.transport);

      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
      this.serverInfo = init && init.serverInfo ? init.serverInfo : null;
      this.notify('notifications/initialized', {});

      const listed = await this.request('tools/list', {});
      this.tools = (listed && listed.tools) || [];
      this.alive = true;
      this.ready = true;
      this.lastError = null;
      log('ok', `[mcp-client] ${this.name}: подключён, инструментов ${this.tools.length}`);
      return true;
    } catch (e) {
      this.alive = false;
      this.lastError = e.message;
      log('error', `[mcp-client] ${this.name}: не подключился — ${e.message}`);
      return false;
    }
  }

  async startStdio() {
    if (!this.command) throw new Error('Не задана команда для stdio-сервера');
    // shell нужен только для .cmd/.bat (npx, npm) на Windows. Для .exe он
    // вреден: cmd режет путь по пробелу («C:\Program Files\...") и падает с
    // «'C:\Program' is not recognized». На *nix shell не нужен вовсе.
    const needsShell =
      process.platform === 'win32' && !/\.exe$/i.test(this.command);
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const s = String(chunk).trim();
      if (s) log('info', `[mcp-client] ${this.name} (stderr): ${s.slice(0, 500)}`);
    });
    child.on('error', (e) => this.failAll(e));
    child.on('exit', (code, signal) => {
      this.alive = false;
      this.failAll(new Error(`процесс завершился (code=${code}, signal=${signal})`));
    });
    this.alive = true;
  }

  async startHttp() {
    if (!this.url) throw new Error('Не задан URL для http-сервера');
    this.alive = true;
  }

  // Разбор stdout stdio-сервера: по одному JSON-объекту на строку (так работает
  // официальный SDK; Content-Length-фрейминг MCP не использует).
  onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('warn', `[mcp-client] ${this.name}: не JSON в stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
      else resolve(msg.result);
    }
    // Запросы от сервера к клиенту (sampling, roots) не поддерживаем — можно
    // ответить -32601, но большинство серверов их и не шлют.
  }

  failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    if (this.transport === 'stdio') {
      return this.sendStdio(msg);
    }
    return this.sendHttp(msg);
  }

  sendStdio(msg) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('stdio-канал закрыт'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error('таймаут MCP-запроса: ' + msg.method));
      }, CALL_TIMEOUT_MS);
      this.pending.set(msg.id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  async sendHttp(msg) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers },
        body: JSON.stringify(msg),
        signal: ctrl.signal,
      });
      const text = await res.text();
      // Сервер вправе ответить SSE-потоком — вытаскиваем первый data:.
      let payload = text;
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        const m = text.match(/^data:\s*(.+)$/m);
        payload = m ? m[1] : '{}';
      }
      const obj = JSON.parse(payload);
      if (obj.error) throw new Error(obj.error.message || 'MCP error');
      return obj.result;
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    try {
      if (this.transport === 'stdio' && this.child && this.child.stdin.writable) {
        this.child.stdin.write(JSON.stringify(msg) + '\n');
      } else if (this.transport === 'http') {
        fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.headers },
          body: JSON.stringify(msg),
        }).catch(() => {});
      }
    } catch { /* уведомление — не критично */ }
  }

  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    return result;
  }

  stop() {
    this.alive = false;
    this.ready = false;
    this.failAll(new Error('клиент остановлен'));
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch { /* ok */ }
      try {
        this.child.kill();
      } catch { /* ok */ }
      this.child = null;
    }
  }
}

// Менеджер внешних серверов. Один на мост: стартует при запуске, держит
// подключения, отдаёт проксированные инструменты и маршрутизирует вызовы.
export class McpClientManager {
  constructor(configs) {
    this.configs = configs || [];
    this.clients = new Map();
  }

  async startAll() {
    for (const cfg of this.configs) {
      if (cfg.enabled === false) continue;
      const client = new McpClient(cfg);
      this.clients.set(cfg.name, client);
      await client.start();
    }
  }

  // Инструменты всех живых внешних серверов в формате MCP, с префиксом имени
  // сервера, чтобы не столкнуться с родными: computer_use__screenshot.
  proxiedTools() {
    const out = [];
    for (const client of this.clients.values()) {
      if (!client.alive || !client.ready) continue;
      for (const t of client.tools) {
        out.push({
          name: `${client.name}__${t.name}`,
          description: `[${client.name}] ${t.description || ''}`.trim(),
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          _meta: { source: 'mcp', server: client.name, originalName: t.name },
        });
      }
    }
    return out;
  }

  has(toolName) {
    const i = toolName.indexOf('__');
    if (i < 0) return null;
    const server = toolName.slice(0, i);
    const original = toolName.slice(i + 2);
    const client = this.clients.get(server);
    if (!client || !client.alive || !client.ready) return null;
    return { client, original };
  }

  async call(toolName, args) {
    const found = this.has(toolName);
    if (!found) throw new Error('Внешний инструмент не найден: ' + toolName);
    return found.client.call(found.original, args);
  }

  status() {
    return [...this.clients.values()].map((c) => ({
      name: c.name,
      transport: c.transport,
      alive: c.alive,
      ready: c.ready,
      tools: c.tools.length,
      error: c.lastError,
      serverInfo: c.serverInfo || null,
    }));
  }

  stopAll() {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
