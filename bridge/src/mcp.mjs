// MCP-сервер внутри моста: второй транспорт поверх того же реестра TOOLS/runTool.
//
// Зачем: dsbridge остаётся как есть (расширение шлёт JSON-блоки на /api/tool), а
// параллельно мост отдаёт свои инструменты по протоколу Model Context Protocol
// (Streamable HTTP, JSON-RPC 2.0) — чтобы его могли подключить Claude Desktop,
// Cursor, VS Code и любой другой MCP-клиент.
//
// Транспорт: POST /mcp с телом JSON-RPC. Отвечаем application/json (сервер вправе
// не открывать SSE, если не стримит). Уведомления (notifications/*) — 202 без тела.
//
// Безопасность: эндпоинт живёт на 127.0.0.1 и требует тот же токен, что и
// остальной API (X-Bridge-Token, ?token= или Authorization: Bearer). Плюс
// отдельная проверка Origin — защита от DNS rebinding, как требует спецификация.

import { TOOLS, runTool } from './tools.mjs';
import { skillList, skillGet, skillRender } from './presets.mjs';
import { log } from './logger.mjs';

// Версия протокола, которую объявляем при initialize. 2025-06-18 — стабильная
// ревизия с tools/* и prompts/*; клиенты сами выберут, что поддерживают.
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SERVER_NAME = 'dsbridge';
const SERVER_VERSION = '0.2.0';

// Имена наборов инструментов (Tool Sets). По имени можно включать/отключать
// целые группы, не перечисляя их в конфиге. Незнакомое имя попадает в 'Прочее'.
const TOOL_SETS = {
  files: [
    'list_dir', 'read_file', 'write_file', 'edit_file', 'edit_many', 'write_binary',
    'make_dir', 'move', 'delete', 'stat', 'copy', 'search', 'tree', 'read_lines',
    'grep', 'hash', 'diff', 'diff_git', 'read_around', 'image_info', 'zip', 'unzip',
  ],
  shell: ['run_command', 'find_tool', 'start_process', 'list_processes', 'kill_process', 'process_logs'],
  git: ['git'],
  screen: ['screenshot', 'list_windows'],
  memory: ['remember', 'recall', 'forget'],
  meta: ['batch', 'usage_stats', 'sysinfo'],
  net: ['download', 'http_get', 'http_post'],
};

const SET_LABELS = {
  files: 'Файлы',
  shell: 'Команды и процессы',
  git: 'Git',
  screen: 'Экран',
  memory: 'Память',
  meta: 'Служебные',
  net: 'Сеть',
  other: 'Прочее',
};

function toolSetOf(name) {
  for (const [set, names] of Object.entries(TOOL_SETS)) {
    if (names.includes(name)) return set;
  }
  return 'other';
}

// Описания параметров в реестре — человекочитаемые строки на русском
// ('строка', 'число, ...', 'boolean, ...'). MCP требует JSON Schema, поэтому
// тип выводим из первого слова, а само описание отдаём как есть.
function inferJsonType(desc) {
  if (typeof desc !== 'string') return 'string';
  const d = desc.trim().toLowerCase();
  if (d.startsWith('число')) return 'number';
  if (d.startsWith('boolean')) return 'boolean';
  if (d.startsWith('массив')) return 'array';
  if (d.startsWith('объект')) return 'object';
  return 'string';
}

function toInputSchema(parameters) {
  const properties = {};
  if (parameters && typeof parameters === 'object') {
    for (const [key, desc] of Object.entries(parameters)) {
      const type = inferJsonType(desc);
      const prop = { type, description: String(desc) };
      if (type === 'array') prop.items = { type: 'string' };
      properties[key] = prop;
    }
  }
  return { type: 'object', properties, additionalProperties: true };
}

// Реестр моста → список инструментов MCP. toolSet уезжает в _meta — клиент
// может группировать по наборам, спецификация лишние поля в _meta разрешает.
export function listMcpTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: toInputSchema(t.parameters),
    _meta: { toolSet: toolSetOf(t.name), toolSetLabel: SET_LABELS[toolSetOf(t.name)] },
  }));
}

// Результат runTool — произвольный объект. MCP ждёт content: [{type, text}].
// Отдаём компактный JSON строкой плюс structuredContent для клиентов, которые
// умеют его читать (это разрешено спецификацией 2025-06-18).
function toCallResult(result) {
  let text;
  try {
    text = JSON.stringify(result, null, 2);
  } catch {
    text = String(result);
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: result && typeof result === 'object' ? result : undefined,
    isError: false,
  };
}

function toErrorResult(code, message) {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

// Обработка одного JSON-RPC сообщения. Возвращает объект-ответ или null,
// если это уведомление (на него по спецификации отвечать не нужно).
export async function handleRpc(cfg, msg, mcpClients = null) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg && msg.id, -32600, 'Некорректный JSON-RPC запрос');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'Мост к локальной файловой системе. Инструменты те же, что и в dsbridge: ' +
            'файлы, команды, git, скриншоты, память. Пути — относительно рабочей папки.',
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null; // уведомление — молчим

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list': {
        // Родные инструменты моста + проксированные от внешних MCP-серверов.
        const all = listMcpTools();
        if (mcpClients) all.push(...mcpClients.proxiedTools());
        const onlySet = params && params._meta && params._meta.toolSet;
        const tools = onlySet ? all.filter((t) => t._meta.toolSet === onlySet) : all;
        return rpcResult(id, { tools });
      }

      // Скиллы отдаются как MCP prompts: Claude Desktop, Cursor и прочие клиенты
      // увидят их как слэш-команды. Пользователь один раз описал workflow — и он
      // воспроизводится, а модели не нужно угадывать последовательность шагов.
      case 'prompts/list': {
        const prompts = skillList().map((s) => ({
          name: s.name,
          description: s.description || '',
          arguments: s.arguments,
        }));
        return rpcResult(id, { prompts });
      }

      case 'prompts/get': {
        const name = params && params.name;
        if (!name) return rpcError(id, -32602, 'Не указано имя промпта');
        try {
          const s = skillGet(name);
          // Если у скилла объявлены аргументы, а значения не переданы — рендер
          // оставит плейсхолдеры как есть. Клиент сам решит, спрашивать ли их.
          const rendered = skillRender(name, (params && params.arguments) || {});
          const messages = [
            {
              role: 'user',
              content: { type: 'text', text: rendered.text },
            },
          ];
          return rpcResult(id, { description: s.description || '', messages });
        } catch (e) {
          return rpcError(id, -32602, e.message);
        }
      }

      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (!name) return rpcError(id, -32602, 'Не указано имя инструмента');
        log('info', `[mcp] → ${name}`);
        try {
          // Имя вида "server__tool" уходит внешнему MCP-серверу, остальное —
          // родным инструментам моста.
          const external = mcpClients ? mcpClients.has(name) : null;
          const result = external
            ? await mcpClients.call(name, args)
            : await runTool(cfg, name, args);
          log('ok', `[mcp] ✓ ${name}`);
          return rpcResult(id, toCallResult(result));
        } catch (e) {
          log('error', `[mcp] ✗ ${name}: ${e.message}`, { code: e.code || 'EUNKNOWN' });
          // Ошибка инструмента — это не ошибка JSON-RPC: отдаём isError: true,
          // чтобы клиент показал её модели, а не считал транспорт сломанным.
          return rpcResult(id, toErrorResult(e.code || 'EUNKNOWN', e.message));
        }
      }

      default: {
        if (isNotification) return null;
        return rpcError(id, -32601, 'Метод не поддерживается: ' + method);
      }
    }
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, 'Внутренняя ошибка: ' + e.message);
  }
}

// Проверка Origin для MCP: если браузер прислал Origin и он не из белого
// списка — отказываем. Не-браузерные клиенты (Claude Desktop, Cursor) Origin
// не шлют вовсе, и это нормально.
export function originAllowedMcp(cfg, origin) {
  if (!origin) return true;
  if (cfg.allowedOrigins && cfg.allowedOrigins.includes(origin)) return true;
  if (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) return true;
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
  return false;
}

// Токен для MCP: тот же, что у остального API, но добавляем Bearer, потому что
// так делают MCP-клиенты.
export function authOkMcp(cfg, req, url, safeEqual) {
  const header = req.headers['x-bridge-token'];
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const query = url.searchParams.get('token');
  return (
    safeEqual(String(header || ''), cfg.token) ||
    safeEqual(String(bearer || ''), cfg.token) ||
    safeEqual(String(query || ''), cfg.token)
  );
}
