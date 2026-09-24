import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig, saveConfig, normalizeRoots } from './config.mjs';
import { getIndexHtml } from './assets.mjs';
import { log, subscribe } from './logger.mjs';
import { safeEqual, resolveInJail } from './security.mjs';
import { TOOLS, runTool } from './tools.mjs';
import { pickFolder } from './shell.mjs';
import {
  handleRpc,
  authOkMcp,
  originAllowedMcp,
  listMcpTools,
  MCP_PROTOCOL_VERSION,
} from './mcp.mjs';
import { McpClientManager } from './mcp-client.mjs';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.zip': 'application/zip',
};

const STARTED_AT = Date.now();

const cfg = loadConfig();

// Внешние MCP-серверы. Стартуют в фоне: если какой-то не поднимется, мост всё
// равно работает — инструменты этого сервера просто не появятся в списке.
const mcpClients = new McpClientManager(cfg.mcpServers || []);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {};
  if (
    origin &&
    (cfg.allowedOrigins.includes(origin) ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('http://localhost'))
  ) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Bridge-Token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    // Chrome Private Network Access: без этого заголовка запрос с публичной
    // страницы (и из расширения) к localhost может быть заблокирован.
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function json(res, req, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

function authOk(req, url) {
  const headerToken = req.headers['x-bridge-token'];
  const queryToken = url.searchParams.get('token');
  return safeEqual(String(headerToken || ''), cfg.token) || safeEqual(String(queryToken || ''), cfg.token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function openTarget(target) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${target}"`
      : process.platform === 'darwin'
        ? `open "${target}"`
        : `xdg-open "${target}"`;
  exec(cmd, () => {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  try {
    if (p === '/' || p === '/index.html') {
      let html = getIndexHtml();
      html = html
        .replaceAll('__BRIDGE_TOKEN__', cfg.token)
        .replaceAll('__WORKSPACE__', escapeHtml(cfg.workspaceRoot))
        .replaceAll('__PORT__', String(cfg.port))
        .replaceAll('__VERSION__', cfg.version);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (p === '/api/health') {
      return json(res, req, 200, {
        ok: true,
        name: cfg.name,
        version: cfg.version,
        workspace: cfg.workspaceRoot,
        port: cfg.port,
        allowCommands: cfg.allowCommands === true,
        allowNetwork: cfg.allowNetwork === true,
        extraRoots: cfg.extraRoots || [],
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        tools: TOOLS.map((t) => t.name),
      });
    }

    if (p === '/api/events') {
      if (!authOk(req, url)) {
        return json(res, req, 401, { ok: false, error: { code: 'EAUTH', message: 'Неверный токен' } });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(req),
      });
      res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), level: 'info', message: 'Поток событий подключён' })}\n\n`);
      const unsubscribe = subscribe(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // соединение закрылось — отпишемся ниже
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    // ---- MCP (Streamable HTTP, JSON-RPC 2.0) ----
    // Второй транспорт к тому же реестру инструментов. Живёт рядом с /api/tool,
    // чтобы мост могли подключить Claude Desktop, Cursor, VS Code и прочие
    // MCP-клиенты — без расширения и без JSON-блоков в чате.
    if (p === '/mcp') {
      if (!originAllowedMcp(cfg, req.headers.origin)) {
        return json(res, req, 403, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Origin не разрешён' },
        });
      }
      if (!authOkMcp(cfg, req, url, safeEqual)) {
        res.writeHead(401, {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Bearer realm="dsbridge"',
          ...corsHeaders(req),
        });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Неверный токен' } }));
      }
      if (req.method === 'GET') {
        // Streamable HTTP допускает GET для SSE-потока сервер→клиент. Нам пока
        // нечего пушить, поэтому вежливо сообщаем, что метод не поддержан.
        res.writeHead(405, { Allow: 'POST', ...corsHeaders(req) });
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', ...corsHeaders(req) });
        return res.end();
      }

      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || 'null');
      } catch {
        return json(res, req, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: некорректный JSON' },
        });
      }
      if (payload === null || payload === undefined) {
        return json(res, req, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Пустое сообщение' },
        });
      }

      const batch = Array.isArray(payload);
      const messages = batch ? payload : [payload];
      const responses = [];
      for (const msg of messages) {
        const r = await handleRpc(cfg, msg, mcpClients);
        if (r !== null) responses.push(r);
      }

      if (responses.length === 0) {
        // Все сообщения были уведомлениями — по спецификации отвечаем 202 без тела.
        res.writeHead(202, corsHeaders(req));
        return res.end();
      }
      return json(res, req, 200, batch ? responses : responses[0]);
    }

    if (!authOk(req, url)) {
      return json(res, req, 401, {
        ok: false,
        error: { code: 'EAUTH', message: 'Неверный токен. Скопируйте токен из UI моста.' },
      });
    }

    if (p === '/api/tools') {
      // Родные инструменты + проксированные от внешних MCP-серверов.
      const external = mcpClients.proxiedTools();
      return json(res, req, 200, { ok: true, tools: TOOLS, external });
    }

    // Статус подключённых внешних MCP-серверов: кто жив, сколько инструментов,
    // какая ошибка при подключении.
    if (p === '/api/mcp/status') {
      return json(res, req, 200, { ok: true, servers: mcpClients.status() });
    }

    // Отдача файла из рабочей папки (картинки, скачивание). Токен — в query,
    // потому что src у <img> заголовки задать не может.
    if (p === '/api/raw') {
      const relPath = url.searchParams.get('path') || '';
      let abs;
      try {
        abs = resolveInJail(cfg.workspaceRoot, relPath, cfg.extraRoots);
      } catch {
        return json(res, req, 403, { ok: false, error: { code: 'EPATHJAIL', message: 'Путь вне рабочей папки' } });
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        return json(res, req, 404, { ok: false, error: { code: 'ENOENT', message: 'Файл не найден' } });
      }
      if (st.isDirectory()) {
        return json(res, req, 400, { ok: false, error: { code: 'EISDIR', message: 'Это директория' } });
      }
      const ext = path.extname(abs).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': String(st.size),
        ...corsHeaders(req),
      };
      if (url.searchParams.get('download')) {
        headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
      }
      res.writeHead(200, headers);
      fs.createReadStream(abs).pipe(res);
      return;
    }

    if (p === '/api/open-file' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, req, 400, { ok: false, error: { code: 'EJSON', message: 'Некорректный JSON' } });
      }
      let abs;
      try {
        abs = resolveInJail(cfg.workspaceRoot, payload.path, cfg.extraRoots);
      } catch {
        return json(res, req, 403, { ok: false, error: { code: 'EPATHJAIL', message: 'Путь вне рабочей папки' } });
      }
      if (!fs.existsSync(abs)) {
        return json(res, req, 404, { ok: false, error: { code: 'ENOENT', message: 'Файл не найден' } });
      }
      openTarget(abs);
      log('info', 'Открыт файл: ' + payload.path);
      return json(res, req, 200, { ok: true, path: payload.path });
    }

    if (p === '/api/pick-folder' && req.method === 'POST') {
      try {
        const chosen = await pickFolder();
        if (!chosen) return json(res, req, 200, { ok: false, cancelled: true });
        return json(res, req, 200, { ok: true, path: chosen });
      } catch (e) {
        return json(res, req, 500, { ok: false, error: { code: 'EPICK', message: e.message } });
      }
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, req, 400, { ok: false, error: { code: 'EJSON', message: 'Некорректный JSON' } });
      }
      if (typeof payload.allowCommands === 'boolean') {
        cfg.allowCommands = payload.allowCommands;
        saveConfig(cfg);
        log('warn', 'Выполнение команд: ' + (cfg.allowCommands ? 'ВКЛЮЧЕНО' : 'выключено'));
      }
      if (typeof payload.allowNetwork === 'boolean') {
        cfg.allowNetwork = payload.allowNetwork;
        saveConfig(cfg);
        log('warn', 'Сетевой доступ: ' + (cfg.allowNetwork ? 'ВКЛЮЧЕН' : 'выключен'));
      }
      if (Array.isArray(payload.extraRoots)) {
        cfg.extraRoots = normalizeRoots(payload.extraRoots);
        saveConfig(cfg);
        log('warn', 'Дополнительные папки: ' + (cfg.extraRoots.length ? cfg.extraRoots.join(', ') : 'нет'));
      }
      if (typeof payload.workspaceRoot === 'string' && payload.workspaceRoot.trim()) {
        const next = path.resolve(payload.workspaceRoot.trim());
        fs.mkdirSync(next, { recursive: true });
        cfg.workspaceRoot = next;
        saveConfig(cfg);
        log('warn', 'Рабочая папка: ' + next);
      }
      return json(res, req, 200, {
        ok: true,
        allowCommands: cfg.allowCommands === true,
        allowNetwork: cfg.allowNetwork === true,
        extraRoots: cfg.extraRoots || [],
        workspace: cfg.workspaceRoot,
      });
    }

    if (p === '/api/open' && req.method === 'POST') {
      openTarget(cfg.workspaceRoot);
      return json(res, req, 200, { ok: true, opened: cfg.workspaceRoot });
    }

    if (p === '/api/tool' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, req, 400, { ok: false, error: { code: 'EJSON', message: 'Некорректный JSON' } });
      }
      const tool = payload && payload.tool;
      const args = (payload && payload.args) || {};
      log('info', `→ ${tool}`, { args });
      try {
        // Имя вида "server__tool" уходит внешнему MCP-серверу, остальное —
        // родным инструментам. Так внешние MCP-инструменты доступны и через
        // dsbridge-транспорт (расширение), а не только через /mcp.
        const result = mcpClients.has(tool)
          ? await mcpClients.call(tool, args)
          : await runTool(cfg, tool, args);
        log('ok', `✓ ${tool}`, { target: result.path || result.to || result.trashed || null });
        return json(res, req, 200, { ok: true, tool, result });
      } catch (e) {
        log('error', `✗ ${tool}: ${e.message}`, { code: e.code || 'EUNKNOWN' });
        return json(res, req, 200, { ok: false, tool, error: { code: e.code || 'EUNKNOWN', message: e.message } });
      }
    }

    return json(res, req, 404, { ok: false, error: { code: 'ENOTFOUND', message: 'Не найдено: ' + p } });
  } catch (e) {
    log('error', 'Ошибка сервера: ' + e.message);
    return json(res, req, 500, { ok: false, error: { code: 'ESERVER', message: e.message } });
  }
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      log('warn', `Порт ${port} занят, пробую ${port + 1}`);
      listen(port + 1, attempt + 1);
    } else {
      log('error', 'Не удалось запустить мост: ' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', async () => {
    cfg.port = port;
    const url = `http://127.0.0.1:${port}/`;
    log('info', `Мост запущен: ${url}`);
    // Внешние MCP-серверы подключаем после старта HTTP — чтобы их падение
    // (или долгий npx) не задерживало основной мост.
    if ((cfg.mcpServers || []).length) {
      mcpClients.startAll().catch((e) => log('error', 'MCP-клиенты: ' + e.message));
    }
    log('info', `Рабочая папка: ${cfg.workspaceRoot}`);
    log('info', `Инструментов: ${TOOLS.length} — ${TOOLS.map((t) => t.name).join(', ')}`);
    if (cfg.autoOpen && !process.env.DSBRIDGE_NO_OPEN) openTarget(url);
  });
}

listen(cfg.port);

process.on('SIGINT', () => {
  log('info', 'Мост остановлен');
  process.exit(0);
});
