// Сборка одного exe через Node SEA (Single Executable Application).
//
// SEA принимает ровно ОДИН CommonJS-скрипт, поэтому src/*.mjs сначала склеиваются
// в один bundle.cjs своим мини-бандлером (см. ниже), а внешние файлы — public/index.html
// и scripts/screenshot.ps1 — вшиваются в код как строки (модуль src/assets.mjs
// подменяется целиком). Иначе exe падает на первом же `import` или на чтении public/.
//
// Требует: Node >= 20, npx (для postject). Запуск: node build.mjs [--no-verify]
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const ENTRY = 'server.mjs';
const BUNDLE = path.join(DIST, 'bundle.cjs');
const BLOB = path.join(DIST, 'bridge.blob');
const OUT_EXE = path.join(DIST, 'dsbridge.exe');

const skipVerify = process.argv.includes('--no-verify');

fs.mkdirSync(DIST, { recursive: true });

// ---------------------------------------------------------------- бандлер

// Разбираем ровно то подмножество ESM, которое есть в src: `import X from`, `import {a,b} from`,
// `export const|let|var|function|class`. На всём остальном — падаем, а не собираем молча сломанное.
function resolveId(fromId, spec) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));
}

function transform(code, id) {
  const exported = [];
  const ref = (spec) => `__require(${JSON.stringify(spec.startsWith('.') ? resolveId(id, spec) : spec)})`;

  code = code.replace(/^#![^\n]*\n/, '');
  code = code.replace(/import\.meta\.url/g, '__importMetaUrl');

  code = code.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (m, clause, spec) => {
    const c = clause.trim();
    if (c.startsWith('{')) return `const ${c} = ${ref(spec)};`;
    if (c.startsWith('*')) return `const ${c.replace(/^\*\s*as\s*/, '')} = ${ref(spec)};`;
    // Смешанная форма `import X, { a, b } from '...'`: имя по умолчанию плюс
    // именованные. Без этой ветки получалось `const X, { a } = ...` — синтаксическая
    // ошибка, и exe падал на старте (ловлено самопроверкой сборки 20.09.2026).
    // __require кэширует модули, поэтому второй вызов — это тот же объект.
    const mixed = /^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/.exec(c);
    if (mixed) return `const ${mixed[1]} = ${ref(spec)};\nconst ${mixed[2]} = ${ref(spec)};`;
    return `const ${c} = ${ref(spec)};`;
  });

  // `import './x.mjs';` — побочный эффект без привязки имени.
  code = code.replace(/^[ \t]*import\s+["']([^"']+)["'];?[ \t]*$/gm, (m, spec) => `${ref(spec)};`);

  // Ни один import не должен пережить трансформер: непонятая форма раньше
  // доезжала до exe как есть и падала уже на запущенном файле.
  const leftoverImport = code.match(/^[ \t]*import[\s{"'*].*$/m);
  if (leftoverImport) {
    throw new Error(
      `Не разобрал import в ${id}: ${leftoverImport.trim()}\n` +
        'Бандлер умеет: import X from, import {a,b} from, import X, {a} from, import * as X from, import "./x.mjs".',
    );
  }

  code = code.replace(
    /^[ \t]*export\s+(async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (m, kind, name) => {
      exported.push(name);
      return `${kind} ${name}`;
    },
  );

  const leftovers = code.match(/^[ \t]*export\s.*$/m);
  if (leftovers) {
    throw new Error(`Неподдерживаемый экспорт в ${id}: ${leftovers.trim()}\nБандлер умеет только export const/let/var/function/class.`);
  }

  if (exported.length) {
    code += `\n${exported.map((n) => `exports.${n} = ${n};`).join('\n')}\n`;
  }
  return code;
}

function buildBundle() {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs')).sort();
  if (!files.includes(ENTRY)) throw new Error(`Не найден вход: src/${ENTRY}`);
  if (!files.includes('assets.mjs')) throw new Error('Не найден src/assets.mjs — бандлер подменяет его исходник, без него exe не найдёт public/ и scripts/');

  const parts = [
    '// Сгенерировано build.mjs из bridge/src — не править руками.',
    "'use strict';",
    '',
    'const __modules = Object.create(null);',
    'const __cache = Object.create(null);',
    'const __importMetaUrl = (typeof __filename === "string" && __filename)',
    '  ? require("node:url").pathToFileURL(__filename).href',
    '  : "file:///" + String(process.execPath).replace(/\\\\/g, "/").replace(/^\\/+/, "");',
    '',
    'function __require(id) {',
    '  if (!Object.prototype.hasOwnProperty.call(__modules, id)) return require(id); // builtin',
    '  if (__cache[id]) return __cache[id].exports;',
    '  const module = { exports: {} };',
    '  __cache[id] = module;',
    '  __modules[id](module, module.exports, __require);',
    '  return module.exports;',
    '}',
    '',
  ];

  for (const file of files) {
    // assets.mjs в exe-режиме берёт содержимое не с диска, а из вшитых строк.
    // Сгенерированный исходник идёт через тот же трансформер, что и обычные модули, —
    // иначе его `import` попадёт в CJS-бандл как есть и exe упадёт на старте.
    const source = file === 'assets.mjs' ? buildAssetsModule() : fs.readFileSync(path.join(SRC, file), 'utf8');
    parts.push(`__modules[${JSON.stringify(file)}] = function (module, exports, __require) {`);
    parts.push(transform(source, file).trimEnd());
    parts.push('};\n');
  }

  parts.push('__require(' + JSON.stringify(ENTRY) + ');\n');

  fs.writeFileSync(BUNDLE, parts.join('\n'), 'utf8');
  return { files, bytes: fs.statSync(BUNDLE).size };
}

// В exe нет ни public/, ни scripts/ — отдаём их содержимое строками.
function buildAssetsModule() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const ps1 = fs.readFileSync(path.join(__dirname, 'scripts', 'screenshot.ps1'), 'utf8');
  return `// Сгенерировано build.mjs — содержимое public/index.html и scripts/screenshot.ps1 вшито в код.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STANDALONE = true;

const INDEX_HTML = ${JSON.stringify(html)};
const SCREENSHOT_PS1 = ${JSON.stringify(ps1)};

export function getIndexHtml() {
  return INDEX_HTML;
}

let unpacked = null;

export function screenshotScriptPath() {
  if (unpacked) return unpacked;
  const dir = path.join(os.tmpdir(), 'dsbridge-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  unpacked = path.join(dir, 'screenshot.ps1');
  fs.writeFileSync(unpacked, SCREENSHOT_PS1, 'utf8');
  return unpacked;
}
`;
}

// ---------------------------------------------------------------- проверка результата

function getJson(port, pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут запроса')));
    req.on('error', reject);
  });
}

function callTool(port, token, tool, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ tool, args });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/tool',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Bridge-Token': token,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`${tool}: не JSON (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${tool}: таймаут`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Сборка «прошла успешно» ничего не значит: копируем exe в чистую временную папку,
// запускаем без файлов проекта и дёргаем живые эндпоинты и инструменты.
async function verify() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-verify-'));
  const copy = path.join(tmp, 'dsbridge.exe');
  fs.copyFileSync(OUT_EXE, copy);

  const dataDir = path.join(tmp, 'data');
  const port = 8510 + Math.floor(Math.random() * 400);
  const child = spawn(copy, [], {
    cwd: tmp,
    env: {
      ...process.env,
      NODE_OPTIONS: '', // шим safe-delete ломает rmSync внутри моста
      DSBRIDGE_NO_OPEN: '1',
      DSBRIDGE_PORT: String(port),
      DSBRIDGE_DATA: dataDir,
      DSBRIDGE_WORKSPACE: path.join(tmp, 'ws'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const problems = [];
  const done = [];
  try {
    let health = null;
    for (let i = 0; i < 60 && !health; i++) {
      await sleep(250);
      if (child.exitCode !== null) break;
      try {
        health = await getJson(port, '/api/health');
      } catch {
        /* ещё не поднялся */
      }
    }

    if (child.exitCode !== null) {
      problems.push(`процесс завершился с кодом ${child.exitCode}: ${out.trim().split('\n').slice(0, 4).join(' | ')}`);
    } else if (!health || health.status !== 200) {
      problems.push('не отвечает /api/health');
    } else {
      const info = JSON.parse(health.body);
      if (!info.ok) problems.push('/api/health вернул ok:false');
      if (!Array.isArray(info.tools) || info.tools.length < 25) problems.push('список инструментов пуст или короче ожидаемого');
      if (info.port !== port) problems.push(`порт в ответе ${info.port}, ожидался ${port}`);
      else done.push('health');

      // UI отдаётся из вшитого html, а не из public/
      const root = await getJson(port, '/');
      if (root.status !== 200) problems.push(`GET / вернул ${root.status}`);
      else if (!root.body.includes('<html')) problems.push('GET / вернул не html');
      else if (root.body.includes('__BRIDGE_TOKEN__')) problems.push('в UI не подставился токен');
      else done.push('UI из вшитого html');

      const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).token;

      // Инструменты: файловый round-trip доказывает, что модули склеены, а не только сервер поднялся.
      // Ответ моста — обёртка { ok, tool, result }.
      await callTool(port, token, 'write_file', { path: 'probe.txt', content: 'привет из exe' });
      const read = await callTool(port, token, 'read_file', { path: 'probe.txt' });
      if (read.result?.content !== 'привет из exe') problems.push(`read_file вернул ${JSON.stringify(read).slice(0, 150)}`);
      else done.push('write_file/read_file');

      const info2 = await callTool(port, token, 'sysinfo', {});
      if (info2.ok !== true) problems.push('sysinfo не отработал: ' + JSON.stringify(info2).slice(0, 150));
      else done.push('sysinfo');

      // Единственный ресурс, который распаковывается на диск, — screenshot.ps1.
      const wins = await callTool(port, token, 'list_windows', {}, 40000);
      if (wins.ok !== true || typeof wins.result?.count !== 'number') {
        problems.push('list_windows не отработал (вшитый screenshot.ps1): ' + JSON.stringify(wins).slice(0, 200));
      } else {
        done.push(`list_windows (${wins.result.count} окон)`);
      }
    }
  } catch (e) {
    problems.push(e.message);
  } finally {
    if (child.exitCode === null) child.kill();
    await sleep(600);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* временная папка, не критично */
    }
  }

  return { problems, log: out, done };
}

// ---------------------------------------------------------------- сборка

console.log('[1/4] Склеиваю src в один CJS-бандл…');
const bundle = buildBundle();
console.log(`      модулей: ${bundle.files.length} (${bundle.files.join(', ')}), ${bundle.bytes} байт`);
console.log(`      вшиты public/index.html и scripts/screenshot.ps1`);

const seaConfig = {
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
fs.writeFileSync(path.join(__dirname, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

console.log('[2/4] Генерирую SEA-блоб…');
execSync(`node --experimental-sea-config "${path.join(__dirname, 'sea-config.json')}"`, { stdio: 'inherit' });

console.log('[3/4] Копирую node.exe и внедряю блоб через postject…');
try {
  fs.copyFileSync(process.execPath, OUT_EXE);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    throw new Error(`${OUT_EXE} занят — закрой запущенный dsbridge.exe и повтори сборку`);
  }
  throw e;
}
execSync(
  `npx --yes postject "${OUT_EXE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: 'inherit' },
);

const sizeMb = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
console.log(`\nГотово: ${OUT_EXE} (${sizeMb} МБ)`);

if (skipVerify) {
  console.log('Проверка пропущена (--no-verify).');
} else {
  console.log('[4/4] Проверяю exe в чистой временной папке…');
  const { problems, log, done } = await verify();
  if (problems.length) {
    console.error('\nПРОВАЛ ПРОВЕРКИ:');
    for (const p of problems) console.error('  - ' + p);
    if (log.trim()) console.error('\nВывод процесса:\n' + log.trim().split('\n').slice(0, 10).join('\n'));
    process.exit(1);
  }
  for (const d of done) console.log('      ok: ' + d);
  console.log(`\nИтог: ${OUT_EXE}`);
}
