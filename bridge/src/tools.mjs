import fsp from 'node:fs/promises';
import fsSync, { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveInJail, toolError, isReservedName, toExtendedPath } from './security.mjs';
import { DATA_DIR } from './config.mjs';
import { screenshotScriptPath } from './assets.mjs';
import { runShell, runProcess, spawnBackground, killTree, decodeClixml } from './shell.mjs';
import { httpRequest, downloadTo, MAX_BODY } from './net.mjs';
import { screenshotPage, findBrowser } from './browser.mjs';

const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh']);
const HASHES = new Set(['sha256', 'sha1', 'sha512', 'md5']);

// git: чистые чтения разрешены всегда, всё остальное — только при allowCommands.
// Подкоманды, которые умеют и читать, и писать (branch, tag, remote, config),
// отнесены к изменяющим: разбирать их аргументы надёжно не получится.
const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame',
  'describe', 'shortlog', 'cat-file', 'grep', 'count-objects', 'merge-base', 'name-rev',
  'symbolic-ref', 'for-each-ref', 'whatchanged', 'version',
]);
const GIT_WRITE = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'clean', 'rm', 'mv', 'push',
  'pull', 'fetch', 'merge', 'rebase', 'stash', 'clone', 'init', 'apply', 'cherry-pick',
  'revert', 'tag', 'branch', 'remote', 'config', 'submodule', 'worktree', 'am', 'gc', 'prune',
  'filter-branch', 'update-ref', 'replace', 'notes', 'bisect',
]);
// Опции уровня git: подкоманда у нас всегда идёт первой, поэтому такие аргументы
// бессмысленны, а через некоторые можно увести git за пределы рабочей папки.
const GIT_BLOCKED_ARG = new Set(['-C', '--exec-path', '--upload-pack', '--receive-pack', '--config-env']);

const MAX_BINARY = 25 * 1024 * 1024; // 25 МБ на write_binary
const MAX_PROCESSES = 20;

// Реестр фоновых процессов. Живёт в памяти моста: после перезапуска
// о запущенных ранее процессах ничего не известно — это ожидаемо.
const processes = new Map();
let nextProcessId = 1;
// Для PowerShell-команд в одинарных кавычках: удваиваем кавычку внутри значения.
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const MAX_READ = 512 * 1024; // 512 KB — потолок на чтение файла
const SEARCH_SCAN_LIMIT = 600;
const SEARCH_MAX_DEPTH = 5;
const SEARCH_RESULTS = 50;
const SKIP_DIRS = new Set(['.trash', '.git', 'node_modules']);

// ---------- вспомогательное ----------

const fsExists = (p) => {
  try {
    fsSync.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// run_command.env — это объект, а не shell-строка, поэтому %Path% и ${VAR}
// сами по себе не раскрываются. Раскрываем вручную: {"Path": "C:\\jdk\\bin;%Path%"}.
function expandEnvValues(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return env;
  const lookup = (name) => {
    if (Object.prototype.hasOwnProperty.call(env, name)) return String(env[name]);
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key ? process.env[key] : undefined;
  };
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = String(v).replace(/%([^%]+)%|\$\{([^}]+)\}/g, (m, a, b) => {
      const val = lookup(a || b);
      return val === undefined ? m : val;
    });
  }
  return out;
}

// ---------- кодировки ----------

const ENC_ALIASES = {
  utf8: 'utf-8', 'utf-8': 'utf-8', utf16le: 'utf-16le', 'utf-16le': 'utf-16le',
  utf16: 'utf-16le', latin1: 'windows-1252', 'windows-1252': 'windows-1252',
  cp1251: 'windows-1251', 'windows-1251': 'windows-1251', cp866: 'ibm866', ibm866: 'ibm866',
  koi8r: 'koi8-r', ascii: 'utf-8',
};

const decodeWith = (buf, enc) => {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
};

// Управляющие символы (кроме \t \n \r) и NUL — признак «не текст».
function looksBinary(buf) {
  let bad = 0;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / Math.max(n, 1) > 0.05;
}

// Кириллические буквы +1, управляющие C1 (0x80–0x9F) −2: у верной кодировки
// букв много, «мусора» нет; у неверной — наоборот.
function cyrScore(s) {
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x410 && c <= 0x44f) || c === 0x401 || c === 0x451) score++;
    else if (c >= 0x80 && c <= 0x9f) score -= 2;
  }
  return score;
}

function detectAndDecode(buf, requested) {
  // По умолчанию — auto: старый Windows-файл в cp1251 больше не отдаёт мусор,
  // а UTF-8 распознаётся как UTF-8. Явная кодировка по-прежнему главнее.
  const req = String(requested || 'auto').toLowerCase();
  if (req && req !== 'auto') {
    const enc = ENC_ALIASES[req] || req;
    return { text: decodeWith(buf, enc), encoding: enc, binary: looksBinary(buf) };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8 (BOM)', binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: decodeWith(buf.subarray(2), 'utf-16le'), encoding: 'utf-16le (BOM)', binary: false };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', binary: false };
  } catch {
    // не UTF-8 — пробуем две самые частые русские кодировки
  }
  const cp1251 = decodeWith(buf, 'windows-1251');
  const cp866 = decodeWith(buf, 'ibm866');
  const pick =
    cyrScore(cp866) > cyrScore(cp1251)
      ? { text: cp866, encoding: 'ibm866 (cp866)' }
      : { text: cp1251, encoding: 'windows-1251 (cp1251)' };
  return { ...pick, binary: looksBinary(buf) };
}

// ---------- diff ----------

const splitLines = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');

// --- поиск фрагмента для правок ---
//
// Точное совпадение всегда первый вариант. Если его нет — пробуем совпадение,
// устойчивое к отступам, хвостовым пробелам и переводам строк: модель часто
// копирует блок из другого места файла или теряет отступ при пересказе. Так же
// ведёт себя str_replace в VS Code. Без этого правка падает с ENOMATCH, модель
// перечитывает файл и тратит лишний round-trip — а лимит частоты у чата не резиновый.
//
// Позиции возвращаются в ИСХОДНОМ тексте: замена идёт по нему, а не по
// нормализованной копии, поэтому файл не переписывается целиком.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fuzzyPositions(text, oldStr) {
  const lines = oldStr.split('\n').map((line) => line.trim());
  if (!lines.some((l) => l)) return [];
  const pattern = lines
    .map((line) => (line ? escapeRe(line).replace(/[ \t]+/g, '[ \\t]+') : ''))
    .join('[ \\t]*\\r?\\n[ \\t]*');
  let re;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return []; // на всякий случай: нерегулярный шаблон не должен ронять правку
  }
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, length: m[0].length });
    if (out.length >= 50) break;
    if (re.lastIndex === m.index) re.lastIndex++; // пустое совпадение — иначе цикл
  }
  return out;
}

// Возврат: позиции (index/length), признак «мягкого» совпадения и сдвиг отступа
// между фрагментом в файле и тем, что прислала модель.
function indexAll(text, needle) {
  const out = [];
  let idx = text.indexOf(needle);
  while (idx !== -1 && out.length < 50) {
    out.push({ index: idx, length: needle.length });
    idx = text.indexOf(needle, idx + needle.length);
  }
  return out;
}

function locateFragment(text, oldStr) {
  // 1) Точное совпадение как есть.
  const exact = indexAll(text, oldStr);
  if (exact.length) return { positions: exact, fuzzy: false, indentShift: 0 };

  // 2) Точное совпадение с другим переводом строк. read_file отдаёт \n, а на
  // диске файл может быть в \r\n — тогда old_string «не находится», хотя это
  // ровно тот фрагмент. Пробуем оба направления, позиции остаются точными,
  // поэтому файл по-прежнему не переписывается целиком.
  if (oldStr.includes('\r\n') || oldStr.includes('\n')) {
    const variants = new Set();
    if (oldStr.includes('\r\n')) variants.add(oldStr.replace(/\r\n/g, '\n'));
    if (/[^\r]\n/.test(oldStr) || oldStr.startsWith('\n')) variants.add(oldStr.replace(/\n/g, '\r\n'));
    for (const variant of variants) {
      if (!variant || variant === oldStr) continue;
      const hit = indexAll(text, variant);
      if (hit.length) return { positions: hit, fuzzy: false, indentShift: 0, eolNormalized: true };
    }
  }

  // 3) Мягкое совпадение: отступы, хвостовые пробелы, переводы строк.
  const fuzzy = fuzzyPositions(text, oldStr);
  if (!fuzzy.length) return { positions: [], fuzzy: true, indentShift: 0 };
  return { positions: fuzzy, fuzzy: true, indentShift: indentShiftAt(text, fuzzy[0].index, oldStr) };
}

// Насколько отступ найденного фрагмента в файле отличается от отступа old_string.
function indentShiftAt(text, index, oldStr) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const fileIndent = (/^[ \t]*/.exec(text.slice(lineStart, index)) || [''])[0];
  const oldIndent = (/^[ \t]*/.exec(oldStr) || [''])[0];
  return fileIndent.length - oldIndent.length;
}

// Сдвигаем new_string так, чтобы отступы совпали с тем, как блок стоял в файле.
// Тонкость: «мягкое» совпадение начинается с первого НЕпробельного символа, то
// есть отступ первой строки остаётся в тексте снаружи замены. Поэтому первой
// строке достаётся только её собственное отличие от old_string, а остальным —
// ещё и разница отступов между файлом и old_string.
function shiftIndent(newStr, delta, fileIndent, oldIndentLen) {
  const ch = fileIndent.includes('\t') ? '\t' : ' ';
  return newStr
    .split('\n')
    .map((line, i) => {
      if (!line.trim()) return line;
      const own = leadingWs(line).length;
      const add = i === 0 ? own - oldIndentLen : own + delta;
      if (add >= 0) return ch.repeat(add) + line;
      // Отступ в файле меньше — срезаем лишнее с начала строки.
      let cut = 0;
      while (cut < -add && (line[cut] === ' ' || line[cut] === '\t')) cut++;
      return line.slice(cut);
    })
    .join('\n');
}

function leadingWs(line) {
  return (/^[ \t]*/.exec(line) || [''])[0];
}

function fileIndentAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return (/^[ \t]*/.exec(text.slice(lineStart, index)) || [''])[0];
}

// Замена по позициям. Для replace_all идём с конца: иначе после первой замены
// все следующие позиции сдвинутся и текст поедет.
function replaceSpans(text, positions, newStr) {
  let out = text;
  for (let i = positions.length - 1; i >= 0; i--) {
    out = out.slice(0, positions[i].index) + newStr + out.slice(positions[i].index + positions[i].length);
  }
  return out;
}

// LCS-диф. Для очень больших файлов (n*m > 4M) не строим таблицу, а честно
// помечаем всё как удалённое+добавленное — иначе теряем память на пустом месте.
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((t) => ({ type: 'del', text: t })), ...b.map((t) => ({ type: 'add', text: t }))];
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

function unifiedDiff(aText, bText, context = 3) {
  const ops = diffOps(splitLines(aText), splitLines(bText));
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const o of ops) {
    if (o.type === 'add') added++;
    else if (o.type === 'del') removed++;
    else same++;
  }

  // Номера строк для каждой операции.
  let aLine = 1;
  let bLine = 1;
  const flat = ops.map((o) => {
    const item = { ...o, a: o.type !== 'add' ? aLine : null, b: o.type !== 'del' ? bLine : null };
    if (o.type !== 'add') aLine++;
    if (o.type !== 'del') bLine++;
    return item;
  });

  const ctx = Math.max(0, Math.min(Number(context) || 3, 10));
  const keep = new Array(flat.length).fill(false);
  for (let k = 0; k < flat.length; k++) {
    if (flat[k].type === 'eq') continue;
    for (let d = -ctx; d <= ctx; d++) {
      const t = k + d;
      if (t >= 0 && t < flat.length) keep[t] = true;
    }
  }

  const lines = [];
  let hunks = 0;
  let k = 0;
  while (k < flat.length) {
    if (!keep[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end + 1 < flat.length && keep[end + 1]) end++;
    const slice = flat.slice(k, end + 1);
    const aStart = slice.find((s) => s.a != null)?.a ?? 1;
    const bStart = slice.find((s) => s.b != null)?.b ?? 1;
    const aCount = slice.filter((s) => s.type !== 'add').length;
    const bCount = slice.filter((s) => s.type !== 'del').length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const s of slice) lines.push((s.type === 'eq' ? ' ' : s.type === 'del' ? '-' : '+') + s.text);
    hunks++;
    k = end + 1;
  }
  return { added, removed, same, hunks, identical: added === 0 && removed === 0, diff: lines.join('\n') };
}

// ---------- метаданные картинки (без зависимостей) ----------

function imageInfoFromBuffer(buf) {
  const info = { format: null, width: null, height: null };
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    info.format = 'png';
    info.width = buf.readUInt32BE(16);
    info.height = buf.readUInt32BE(20);
    return info;
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    info.format = 'gif';
    info.width = buf.readUInt16LE(6);
    info.height = buf.readUInt16LE(8);
    return info;
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    info.format = 'jpeg';
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = buf.readUInt16BE(i + 5);
        info.width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return info;
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    info.format = 'bmp';
    info.width = buf.readInt32LE(18);
    info.height = buf.readInt32LE(22);
    return info;
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    info.format = 'webp';
    const tag = buf.toString('ascii', 12, 16);
    if (tag === 'VP8X') {
      info.width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      info.height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    } else if (tag === 'VP8 ') {
      info.width = buf.readUInt16LE(26) & 0x3fff;
      info.height = buf.readUInt16LE(28) & 0x3fff;
    } else if (tag === 'VP8L') {
      info.width = 1 + (((buf[22] & 0x3f) << 8) | buf[21]);
      info.height = 1 + (((buf[24] & 0xf) << 10) | (buf[23] << 2) | ((buf[22] & 0xc0) >> 6));
    }
    return info;
  }
  return info;
}

// ---------- поиск исполняемых файлов ----------

const EXE_EXTS_WIN = ['.exe', '.cmd', '.bat', '.com'];

async function walkForExe(root, base, exts, add, maxDepth) {
  const stack = [{ dir: root, depth: 0 }];
  const want = base.toLowerCase();
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Заходим в bin/ и в папки версий (jdk-21.0.1, 22.22.2, 3.13.12).
        if (e.name === 'bin' || /^(jdk|jre|python|node|dotnet|gradle|versions?)/i.test(e.name) || /^[\d.]+/.test(e.name)) {
          stack.push({ dir: full, depth: depth + 1 });
        } else if (depth < 2) {
          stack.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const stem = e.name.slice(0, e.name.length - ext.length).toLowerCase();
      if (stem === want && exts.includes(ext)) add(full, 'standard');
    }
  }
}

async function findToolPaths(name) {
  const wanted = String(name || '').trim();
  if (!wanted) throw toolError('EARGS', 'Параметр name обязателен');
  const base = wanted.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  const isWin = process.platform === 'win32';
  const exts = isWin ? EXE_EXTS_WIN : [''];
  const found = [];
  const seen = new Set();
  const add = (p, source) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: p.split(path.sep).join('/'), source });
  };

  // 1) PATH
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, base + ext);
      if (fsExists(cand)) add(cand, 'PATH');
    }
  }

  // 2) стандартные места установки
  const roots = [];
  if (isWin) {
    roots.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', base));
    roots.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', base));
    if (process.env['LOCALAPPDATA']) roots.push(path.join(process.env['LOCALAPPDATA'], 'Programs', base));
    const home = os.homedir();
    roots.push(path.join(home, '.workbuddy-ai', 'binaries', base, 'versions'));
    roots.push(path.join(home, '.workbuddy-ai', 'binaries', base));
  } else {
    roots.push('/usr/bin', '/usr/local/bin', '/opt/' + base, '/snap/bin');
  }
  for (const r of roots.filter(Boolean)) {
    if (!fsExists(r)) continue;
    for (const ext of exts) if (fsExists(r + ext)) add(r + ext, 'standard');
    await walkForExe(r, base, exts, add, 4);
  }
  return { name: base, found, inPath: found.some((f) => f.source === 'PATH') };
}

// ---------- зарезервированные имена Windows ----------
// Node не умеет ни удалять, ни переименовывать такие файлы (EPERM). Пробуем
// обходной путь через PowerShell с префиксом \\?\ и, если не вышло, честно
// говорим об этом — сырой EPERM модели ничего не объясняет.
async function removeReserved(abs) {
  const cmd = `Remove-Item -LiteralPath ${psQuote(toExtendedPath(abs))} -Recurse -Force -ErrorAction Stop`;
  const res = await runShell({ shell: 'powershell', command: cmd, timeoutMs: 20000 });
  return res.exitCode === 0;
}

async function moveReserved(from, to) {
  const cmd = `Move-Item -LiteralPath ${psQuote(toExtendedPath(from))} -Destination ${psQuote(to)} -Force -ErrorAction Stop`;
  const res = await runShell({ shell: 'powershell', command: cmd, timeoutMs: 20000 });
  return res.exitCode === 0;
}

const RESERVED_HINT =
  'Имя зарезервировано Windows как устройство (nul, con, aux, prn, com1-9, lpt1-9) — ' +
  'обычные операции с ним не работают. Попробуй run_command: del \\\\?\\<полный путь> или переименуй папку-родителя.';

// ---------- метрики вызовов ----------

const usage = new Map(); // name -> { calls, errors, totalMs, maxMs, lastAt }
function recordUsage(name, ok, ms) {
  const u = usage.get(name) || { calls: 0, errors: 0, totalMs: 0, maxMs: 0, lastAt: null };
  u.calls++;
  if (!ok) u.errors++;
  u.totalMs += ms;
  if (ms > u.maxMs) u.maxMs = ms;
  u.lastAt = new Date().toISOString();
  usage.set(name, u);
}

// ---------- долговременная память модели ----------

const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
const MEMORY_MAX_KEYS = 500;

function readMemoryFile() {
  try {
    const obj = JSON.parse(fsSync.readFileSync(MEMORY_PATH, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function writeMemoryFile(obj) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
  fsSync.writeFileSync(MEMORY_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- пакетный вызов ----------

const MAX_BATCH = 50;      // вызовов в одном batch
const MAX_BATCH_DEPTH = 1; // batch внутри batch — только на один уровень

// ---------- логи фонового процесса ----------

// Смещение для process_logs { since }. Буфер stdout/stderr у процесса обрезается
// сверху («… обрезано»), поэтому абсолютные смещения не переживают переполнение.
// Отслеживаем это честно: если смещение больше текущей длины буфера — отдаём
// truncated: true и весь буфер, а не молча теряем кусок.
function sliceFrom(buffer, since) {
  const from = Number(since);
  if (!Number.isFinite(from) || from < 0) return { text: buffer, truncated: false };
  if (from > buffer.length) return { text: buffer, truncated: true };
  return { text: buffer.slice(from), truncated: false };
}


export const TOOLS = [
  {
    name: 'list_dir',
    description: 'Список файлов и папок в директории',
    parameters: {
      path: 'строка, по умолчанию "."',
      recursive: 'boolean, обойти вложенные папки (по умолчанию false)',
      maxDepth: 'число, глубина обхода при recursive, по умолчанию 3 (до 10)',
      glob: 'строка, фильтр имён, например "*.js" (только при recursive)',
      withStat: 'boolean, добавить mtimeMs и mtime к каждому элементу (по умолчанию false)',
    },
  },
  { name: 'read_file', description: 'Прочитать текстовый файл', parameters: { path: 'строка', encoding: 'auto (по умолчанию, определяет кодировку) | utf8 | cp1251 | cp866 | utf16le | latin1' } },
  {
    name: 'write_file',
    description: 'Записать файл целиком',
    parameters: { path: 'строка', content: 'строка', mode: 'overwrite | append', createDirs: 'boolean, создавать папки (по умолчанию true)' },
  },
  {
    name: 'edit_file',
    description:
      'Точечная замена фрагмента в файле — без перезаписи всего файла. Если точного совпадения нет, ' +
      'ищет устойчиво к отступам и хвостовым пробелам (в ответе fuzzy: true)',
    parameters: {
      path: 'строка',
      old_string: 'строка, что заменить (должна встречаться ровно один раз, если replace_all=false)',
      new_string: 'строка, на что заменить (пустая строка = удалить фрагмент)',
      replace_all: 'boolean, по умолчанию false',
    },
  },
  {
    name: 'edit_many',
    description:
      'Пакет точечных правок в одном файле — один вызов вместо многих edit_file. ' +
      'Как и edit_file, терпит различия в отступах (в ответе fuzzy: true)',
    parameters: {
      path: 'строка',
      edits: 'массив правок [{ old|old_string, new|new_string, replace_all? }], до 100 штук',
      atomic: 'boolean, по умолчанию true — при любой неудаче не менять файл вовсе; false — применить удачные, пропущенные вернуть в failed',
      dry_run: 'boolean, только показать, что нашлось бы, без записи на диск (по умолчанию false)',
    },
  },
  {
    name: 'write_binary',
    description: 'Записать бинарный файл из base64 (png, zip, шрифт и т.п.)',
    parameters: { path: 'строка', base64: 'строка в base64, можно data:URL', encoding: 'base64 | utf8, по умолчанию base64' },
  },
  { name: 'make_dir', description: 'Создать директорию', parameters: { path: 'строка' } },
  { name: 'move', description: 'Переместить или переименовать', parameters: { from: 'строка', to: 'строка' } },
  { name: 'delete', description: 'Удалить в корзину .trash', parameters: { path: 'строка' } },
  { name: 'stat', description: 'Информация о файле или папке', parameters: { path: 'строка' } },
  { name: 'copy', description: 'Скопировать файл или папку', parameters: { from: 'строка', to: 'строка' } },
  { name: 'search', description: 'Поиск по имени и содержимому', parameters: { query: 'строка', path: 'строка' } },
  { name: 'tree', description: 'Дерево каталогов', parameters: { path: 'строка', depth: 'число, по умолчанию 3' } },
  { name: 'read_lines', description: 'Строки файла: диапазон start/count или последние tail', parameters: { path: 'строка', start: 'число', count: 'число', tail: 'число' } },
  {
    name: 'grep',
    description: 'Поиск по регулярному выражению с номерами строк и контекстом',
    parameters: {
      pattern: 'строка',
      path: 'строка',
      glob: 'строка, фильтр по имени, например "*.js" или ".md"',
      ignoreCase: 'boolean',
      context: 'число, сколько строк до и после показать (0–10)',
      maxResults: 'число',
    },
  },
  { name: 'hash', description: 'Контрольная сумма файла', parameters: { path: 'строка', algo: 'sha256 | sha1 | sha512 | md5' } },
  {
    name: 'diff',
    description: 'Сравнить два текстовых файла и вернуть unified-diff',
    parameters: { pathA: 'строка', pathB: 'строка', context: 'число, строк контекста (0–10, по умолчанию 3)' },
  },
  {
    name: 'diff_git',
    description: 'git diff по файлу относительно ревизии (или рабочего дерева)',
    parameters: { path: 'строка', rev: 'строка, ревизия (например HEAD~1); пусто — рабочее дерево vs индекс', context: 'число, -U' },
  },
  {
    name: 'image_info',
    description: 'Размеры и формат картинки без внешних библиотек',
    parameters: { path: 'строка' },
  },
  {
    name: 'find_tool',
    description: 'Найти, где установлена программа (java, node, dotnet, gradle, python), даже если её нет в PATH',
    parameters: { name: 'строка, имя программы без .exe' },
  },
  {
    name: 'read_around',
    description: 'Прочитать широкий кусок файла вокруг вхождения образца (N строк до и после)',
    parameters: {
      path: 'строка',
      pattern: 'строка, регулярное выражение',
      before: 'число, строк до вхождения (по умолчанию 20, до 500)',
      after: 'число, строк после вхождения (по умолчанию 20, до 500)',
      ignoreCase: 'boolean',
      hit: 'число, какое по счёту вхождение взять, начиная с 1 (по умолчанию 1)',
    },
  },
  {
    name: 'batch',
    description: 'Выполнить несколько инструментов за один вызов — экономит round-trip и лимит сообщений',
    parameters: {
      calls: 'массив [{ tool, args }], до 50 штук; выполняется последовательно, результат в том же порядке',
      stopOnError: 'boolean, по умолчанию false — ошибка одного вызова не мешает остальным',
    },
  },
  {
    name: 'remember',
    description: 'Запомнить факт между сессиями (ключ-значение), живёт в ~/.dsbridge/memory.json',
    parameters: { key: 'строка', value: 'строка или объект', ttl: 'число, секунд; необязательно — срок жизни' },
  },
  {
    name: 'recall',
    description: 'Вспомнить ранее сохранённое: по ключу, по образцу ключа или всё сразу',
    parameters: { key: 'строка, точный ключ', pattern: 'строка, подстрока или regex по ключу', limit: 'число, по умолчанию 50' },
  },
  { name: 'forget', description: 'Удалить запись из памяти модели', parameters: { key: 'строка', all: 'boolean, стереть всё (по умолчанию false)' } },
  {
    name: 'usage_stats',
    description: 'Метрики вызовов инструментов: частота, ошибки, среднее и максимальное время',
    parameters: { sort: 'строка: calls | errors | avg | max | total (по умолчанию total)', limit: 'число, по умолчанию 30', reset: 'boolean, обнулить счётчики после отчёта' },
  },
  { name: 'sysinfo', description: 'Информация о системе, памяти и диске', parameters: {} },
  { name: 'zip', description: 'Упаковать файл или папку в zip (PowerShell)', parameters: { path: 'строка', dest: 'строка' } },
  { name: 'unzip', description: 'Распаковать zip (PowerShell)', parameters: { path: 'строка', dest: 'строка' } },
  { name: 'list_windows', description: 'Список открытых окон — чтобы выбрать окно для скриншота', parameters: {} },
  {
    name: 'screenshot',
    description: 'Скриншот окна, всего экрана или веб-страницы (png в рабочую папку)',
    parameters: {
      url: 'строка — страница: локальный файл рабочей папки (например "index.html") или http(s)-адрес (нужен allowNetwork)',
      window: 'строка, часть заголовка окна, без учёта регистра (пусто = весь экран)',
      process: 'строка, часть имени процесса окна (например "chrome") — надёжнее заголовка',
      handle: 'число, HWND окна из list_windows — самый точный способ выбрать окно',
      foreground: 'boolean, поднять окно на передний план перед снимком (свёрнутое развернётся)',
      path: 'строка, куда сохранить png',
      width: 'число, ширина страницы, по умолчанию 1280',
      height: 'число, высота страницы, по умолчанию 900 (до 12000)',
      waitMs: 'число, сколько ждать отрисовку, мс (по умолчанию 3000)',
      fullPage: 'boolean, отрисовать всю страницу целиком (высокий кадр вместо капа)',
      dark: 'boolean, тёмная тема браузера',
      device: 'строка-пресет: mobile | tablet | desktop — подставляет типовой размер и мобильный UA',
    },
  },
  {
    name: 'python',
    description:
      'Выполнить Python-код (нативный python из PATH). Код передаётся как есть — ' +
      'без shell-экранирования, кавычек и пайпов, поэтому это надёжнее run_command ' +
      'для скриптов. Рабочая папка — cwd, вывод stdout/stderr и код возврата. ' +
      'Нужен флаг «Выполнение команд».',
    parameters: {
      code: 'строка, Python-код (можно многострочный)',
      cwd: 'строка, рабочий каталог, по умолчанию \".\"',
      timeoutMs: 'число, мс (по умолчанию 60000)',
      args: 'массив строк — аргументы для скрипта (sys.argv[1:])',
      stdin: 'строка, что подать на вход скрипту',
    },
  },
  {
    name: 'run_command',
    description:
      'Выполнить команду в PowerShell / cmd / bash (рабочая папка как cwd). ' +
      'На Windows пайп (| findstr) часто даёт пустой stdout — надёжнее писать вывод в файл ' +
      '(`... > build.log 2>&1`) и читать его через read_file. env — это объект, %VAR% в нём ' +
      'не раскрывается: чтобы добавить к PATH, указывай полный путь.',
    parameters: {
      command: 'строка',
      shell: 'powershell | cmd | bash',
      cwd: 'строка, по умолчанию "."',
      env: 'объект с дополнительными переменными окружения, например {"JAVA_HOME":"C:\\\\Program Files\\\\Java\\\\jdk-21"}',
      timeoutMs: 'число, мс (по умолчанию 30000)',
    },
  },
  {
    name: 'git',
    description: 'Git-операции в рабочей папке. Чтение (status, diff, log) всегда; изменения требуют allowCommands',
    parameters: {
      subcommand: 'строка: status | diff | log | show | branch | add | commit | checkout ...',
      args: 'массив строк с аргументами подкоманды, например ["--oneline", "-5"]',
      cwd: 'строка, по умолчанию "."',
    },
  },
  {
    name: 'start_process',
    description: 'Запустить долгий процесс в фоне (сервер предпросмотра) и вернуть pid',
    parameters: {
      command: 'строка',
      shell: 'powershell | cmd | bash',
      cwd: 'строка, по умолчанию "."',
      env: 'объект с переменными окружения',
      name: 'строка, понятное имя процесса, чтобы потом убить по имени',
    },
  },
  { name: 'list_processes', description: 'Список запущенных через мост процессов с хвостом вывода', parameters: {} },
  { name: 'kill_process', description: 'Остановить фоновый процесс (по pid или имени), вместе с деревом', parameters: { pid: 'число', name: 'строка' } },
  {
    name: 'process_logs',
    description: 'Вывод фонового процесса (запущенного start_process): хвост, догон новых строк, очистка буфера',
    parameters: {
      pid: 'число',
      name: 'строка, имя процесса',
      tail: 'число, строк с конца (по умолчанию 100, до 2000)',
      since: 'число, смещение из предыдущего ответа (nextOffset) — вернуть только новое',
      waitMs: 'число, сколько ждать нового вывода, мс (0–30000); аналог tail -f',
      clear: 'boolean, очистить буфер вывода процесса',
    },
  },
  {
    name: 'download',
    description: 'Скачать файл по URL прямо в рабочую папку (картинки, шрифты, архивы). Нужен allowNetwork',
    parameters: { url: 'строка', path: 'строка, куда сохранить (по умолчанию имя из URL)', maxBytes: 'число, до 25 МБ' },
  },
  {
    name: 'http_get',
    description: 'HTTP GET — проверить API или получить данные. Нужен allowNetwork',
    parameters: { url: 'строка', headers: 'объект с заголовками', timeoutMs: 'число, мс' },
  },
  {
    name: 'http_post',
    description: 'HTTP POST с телом — проверить API, вебхук. Нужен allowNetwork',
    parameters: { url: 'строка', body: 'строка с телом', headers: 'объект с заголовками', contentType: 'строка, по умолчанию application/json', timeoutMs: 'число, мс' },
  },
];

// Пути наружу отдаём в POSIX-виде ('/'), независимо от платформы —
// так ответы одинаковы на Windows и *nix и понятнее модели.
// Для путей вне рабочей папки (дополнительный корень) отдаём абсолютный путь:
// «../../Desktop/...» не говорит модели, где это на самом деле. Абсолютный
// путь при этом корректно принимается обратно на вход.
const rel = (root, abs) => {
  const r = path.relative(root, abs);
  if (r && (r.startsWith('..') || path.isAbsolute(r))) return abs.split(path.sep).join('/');
  return r.split(path.sep).join('/') || '.';
};

async function walk(abs, depth, out) {
  if (out.length >= SEARCH_SCAN_LIMIT || depth > SEARCH_MAX_DEPTH) return;
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= SEARCH_SCAN_LIMIT) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(abs, e.name);
    out.push({ abs: full, name: e.name, dir: e.isDirectory() });
    if (e.isDirectory()) await walk(full, depth + 1, out);
  }
}

function processView(entry) {
  return {
    pid: entry.pid,
    name: entry.name,
    shell: entry.shell,
    running: entry.running,
    exitCode: entry.exitCode,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: new Date(entry.startedAt).toISOString(),
    durationMs: (entry.endedAt || Date.now()) - entry.startedAt,
    stdoutTail: entry.stdout.slice(-4000),
    // У фоновых процессов CLIXML приходится разбирать при чтении: куски
    // приходят по частям, и на лету обёртка может оказаться разрезанной.
    stderrTail: (entry.shell === 'powershell' || entry.shell === 'pwsh'
      ? decodeClixml(entry.stderr)
      : entry.stderr
    ).slice(-4000),
  };
}

function findProcess({ pid, name }) {
  if (pid != null && pid !== '') {
    const byId = processes.get(Number(pid));
    if (byId) return byId;
  }
  if (name) {
    const wanted = String(name);
    for (const entry of processes.values()) {
      if (entry.name === wanted) return entry;
    }
  }
  return null;
}

async function runToolInner(cfg, name, args = {}, depth = 0) {
  const root = cfg.workspaceRoot;
  const extraRoots = Array.isArray(cfg.extraRoots) ? cfg.extraRoots : [];
  // Единая точка проверки пути: рабочая папка плюс разрешённые дополнительные
  // каталоги. Пустой список — ровно прежнее поведение.
  const jail = (p) => resolveInJail(root, p, extraRoots);

  switch (name) {
    case 'list_dir': {
      const abs = jail(args.path || '.');
      const recursive = args.recursive === true;
      // withStat отдаёт mtimeMs и размер одним заходом — иначе модель дёргает
      // stat на каждый файл, чтобы понять, что менялось последним.
      const withStat = args.withStat === true;
      const statFields = (st) =>
        withStat ? { size: st.size, mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString() } : {};
      if (!recursive) {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const items = [];
        for (const e of entries) {
          const full = path.join(abs, e.name);
          let size = null;
          let extra = {};
          try {
            const st = await fsp.stat(full);
            if (!e.isDirectory()) size = st.size;
            if (withStat) extra = statFields(st);
          } catch {
            size = null;
          }
          items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, ...extra });
        }
        items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        return { path: rel(root, abs), items };
      }

      // Плоский список с фильтром — для программной обработки (tree даёт картинку).
      const maxDepth = Math.min(Math.max(Number(args.maxDepth) || 3, 1), 10);
      const globRaw = String(args.glob || '').trim();
      let globRe = null;
      if (globRaw) {
        const esc = globRaw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        globRe = new RegExp('^' + esc + '$');
      }
      const items = [];
      const walkRec = async (dir, depth) => {
        if (depth > maxDepth || items.length >= 2000) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const e of entries) {
          if (SKIP_DIRS.has(e.name)) continue;
          const full = path.join(dir, e.name);
          const relPath = rel(root, full);
          if (!globRe || globRe.test(e.name) || relPath.endsWith(globRaw)) {
            let size = null;
            let extra = {};
            if (!e.isDirectory()) {
              try {
                const st = await fsp.stat(full);
                size = st.size;
                if (withStat) extra = statFields(st);
              } catch {
                size = null;
              }
            }
            items.push({ path: relPath, name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, depth, ...extra });
          }
          if (e.isDirectory()) await walkRec(full, depth + 1);
        }
      };
      await walkRec(abs, 1);
      return { path: rel(root, abs), recursive: true, maxDepth, glob: globRaw || null, count: items.length, items };
    }

    case 'read_file': {
      const abs = jail(args.path);
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      const buf = await fsp.readFile(abs);
      const truncated = buf.length > MAX_READ;
      const slice = truncated ? buf.subarray(0, MAX_READ) : buf;
      const decoded = detectAndDecode(slice, args.encoding);
      return {
        path: rel(root, abs),
        bytes: buf.length,
        truncated,
        encoding: decoded.encoding,
        // Явный дубль поля: модели проще заметить detectedEncoding, чем encoding.
        detectedEncoding: decoded.encoding,
        binary: decoded.binary,
        content: decoded.text,
      };
    }

    case 'write_file': {
      const abs = jail(args.path);
      const createDirs = args.createDirs !== false; // по умолчанию папки создаём
      if (createDirs) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
      } else if (!fsExists(path.dirname(abs))) {
        throw toolError('ENOENT', 'Папки нет, а createDirs: false — проверь путь (защита от опечатки)');
      }
      const data = String(args.content ?? '');
      const mode = args.mode === 'append' ? 'append' : 'overwrite';
      if (mode === 'append') await fsp.appendFile(abs, data, 'utf8');
      else await fsp.writeFile(abs, data, 'utf8');
      const st = await fsp.stat(abs);
      return { path: rel(root, abs), bytes: st.size, mode, createdDirs: createDirs };
    }

    case 'edit_file': {
      const abs = jail(args.path);
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) throw toolError('EARGS', 'Параметр old_string обязателен и не может быть пустым');
      if (oldStr === newStr) throw toolError('EARGS', 'old_string и new_string совпадают — менять нечего');

      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      if (st.size > MAX_READ) throw toolError('ETOOLARGE', 'Файл больше 512 КБ — правь через write_file или run_command');

      const text = await fsp.readFile(abs, 'utf8');

      // Считаем вхождения: неоднозначную замену не делаем, а показываем,
      // где именно нашлось — иначе модель правит не то место.
      // Нет точного совпадения — locateFragment пробует «мягкое» (без учёта
      // отступов и хвостовых пробелов).
      const located = locateFragment(text, oldStr);
      const positions = located.positions.map((p) => p.index);
      if (!positions.length) {
        throw toolError('ENOMATCH', 'old_string не найдена в файле — прочитай файл заново и скопируй фрагмент точно');
      }

      const replaceAll = args.replace_all === true;
      if (positions.length > 1 && !replaceAll) {
        const lineOf = (pos) => text.slice(0, pos).split('\n').length;
        const where = positions.slice(0, 10).map((p) => 'строка ' + lineOf(p)).join(', ');
        throw toolError(
          'EAMBIGUOUS',
          `old_string встречается ${positions.length} раз (${where}). Уточни фрагмент или передай replace_all: true`,
        );
      }

      // При точном совпадении с другим переводом строк (CRLF-файл, а модель
      // прислала \n) приводим вставку к переводу строк файла — иначе получились
      // бы смешанные \r\n и \n в одном файле.
      const fileEol = text.includes('\r\n') ? '\r\n' : '\n';
      const normalizedNew = located.eolNormalized ? newStr.replace(/\r?\n/g, fileEol) : newStr;

      // «Мягкое» совпадение — повод сказать об этом в ответе: правка применена,
      // но текст в файле отличался от того, что прислала модель.
      const finalNew = located.fuzzy
        ? shiftIndent(normalizedNew, located.indentShift, fileIndentAt(text, positions[0]), leadingWs(oldStr).length)
        : normalizedNew;

      const updated = replaceAll
        ? replaceSpans(text, located.positions, finalNew)
        : text.slice(0, positions[0]) + finalNew + text.slice(positions[0] + located.positions[0].length);
      await fsp.writeFile(abs, updated, 'utf8');
      const after = await fsp.stat(abs);
      return {
        path: rel(root, abs),
        replacements: replaceAll ? positions.length : 1,
        firstLine: text.slice(0, positions[0]).split('\n').length,
        fuzzy: located.fuzzy,
        indentShift: located.fuzzy ? located.indentShift : 0,
        ...(located.eolNormalized ? { eolNormalized: true, eol: fileEol } : {}),
        bytesBefore: st.size,
        bytesAfter: after.size,
      };
    }

    case 'edit_many': {
      const abs = jail(args.path);
      const edits = Array.isArray(args.edits) ? args.edits : null;
      if (!edits || !edits.length) throw toolError('EARGS', 'Параметр edits — непустой массив правок [{ old, new, replace_all? }]');
      if (edits.length > 100) throw toolError('EARGS', 'Не больше 100 правок за один вызов');

      // Нормализуем и валидируем все правки ДО чтения файла: не хочется
      // рушить текст на середине из-за опечатки в третьем элементе массива.
      const plan = edits.map((e, i) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
          throw toolError('EARGS', `Правка #${i + 1}: ожидается объект { old, new, replace_all? }`);
        }
        // Принимаем оба набора ключей: { old, new } и { old_string, new_string } —
        // модель по привычке от edit_file пишет вторую пару, а раньше это давало
        // невнятное «old не может быть пустой».
        const oldRaw = e.old ?? e.old_string;
        const newRaw = e.new ?? e.new_string;
        if (oldRaw == null && newRaw == null) {
          throw toolError(
            'EARGS',
            `Правка #${i + 1}: нет поля old (или old_string) — ожидается { old, new } либо { old_string, new_string }`,
          );
        }
        const oldStr = String(oldRaw ?? '');
        const newStr = String(newRaw ?? '');
        if (!oldStr) throw toolError('EARGS', `Правка #${i + 1}: old не может быть пустой`);
        if (oldStr === newStr) throw toolError('EARGS', `Правка #${i + 1}: old и new совпадают — менять нечего`);
        return { oldStr, newStr, replaceAll: e.replace_all === true };
      });

      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      if (st.size > MAX_READ) throw toolError('ETOOLARGE', 'Файл больше 512 КБ — правь через write_file или run_command');

      const original = await fsp.readFile(abs, 'utf8');
      const atomic = args.atomic !== false; // по умолчанию — да, всё или ничего
      const dryRun = args.dry_run === true; // только показать, без записи
      let text = original;
      const results = [];
      const failed = [];

      const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;

      for (let i = 0; i < plan.length; i++) {
        const { oldStr, newStr, replaceAll } = plan[i];

        // Считаем вхождения в ТЕКУЩЕМ (уже частично правленом) тексте —
        // правки применяются последовательно, как если бы шли по одной.
        // Мягкое совпадение (без учёта отступов) — как в edit_file.
        const located = locateFragment(text, oldStr);
        const positions = located.positions.map((p) => p.index);

        if (!positions.length) {
          const err = { index: i, code: 'ENOMATCH', message: `Правка #${i + 1}: old не найдена в текущем тексте` };
          if (atomic && !dryRun) throw toolError('ENOMATCH', err.message + ' (файл не изменён)');
          failed.push(err);
          results.push({ index: i, ok: false, code: err.code });
          continue;
        }
        if (positions.length > 1 && !replaceAll) {
          const where = positions.slice(0, 10).map((p) => 'строка ' + lineOf(text, p)).join(', ');
          const msg = `Правка #${i + 1}: old встречается ${positions.length} раз (${where}). Уточни фрагмент или передай replace_all: true`;
          if (atomic && !dryRun) throw toolError('EAMBIGUOUS', msg + ' (файл не изменён)');
          failed.push({ index: i, code: 'EAMBIGUOUS', message: msg });
          results.push({ index: i, ok: false, code: 'EAMBIGUOUS' });
          continue;
        }

        const firstLine = lineOf(text, positions[0]);
        const count = replaceAll ? positions.length : 1;
        // Точное совпадение с другим переводом строк: приводим вставку к EOL файла.
        const fileEol = text.includes('\r\n') ? '\r\n' : '\n';
        const normalizedNew = located.eolNormalized ? newStr.replace(/\r?\n/g, fileEol) : newStr;
        const finalNew = located.fuzzy
          ? shiftIndent(normalizedNew, located.indentShift, fileIndentAt(text, positions[0]), leadingWs(oldStr).length)
          : normalizedNew;
        text = replaceAll
          ? replaceSpans(text, located.positions, finalNew)
          : text.slice(0, positions[0]) + finalNew + text.slice(positions[0] + located.positions[0].length);
        results.push({ index: i, ok: true, replacements: count, firstLine, fuzzy: located.fuzzy });
      }

      const applied = results.filter((r) => r.ok).length;

      // Атомарный режим при провале уже свалился исключением выше, файл не тронут.
      // Неатомарный — пишем то, что получилось, даже если что-то пропущено.
      // dry_run — не пишем вообще.
      if (!dryRun && (applied > 0 || !atomic)) {
        await fsp.writeFile(abs, text, 'utf8');
      }
      const after = dryRun ? st : await fsp.stat(abs);
      return {
        path: rel(root, abs),
        total: plan.length,
        applied,
        failed: failed.length,
        atomic,
        dryRun,
        results,
        ...(failed.length ? { failures: failed } : {}),
        bytesBefore: st.size,
        bytesAfter: after.size,
        ...(dryRun ? { note: 'dry_run: файл не изменён' } : {}),
      };
    }

    case 'write_binary': {
      const abs = jail(args.path);
      let raw = String(args.base64 ?? '').trim();
      if (!raw) throw toolError('EARGS', 'Параметр base64 обязателен');

      // Модель часто отдаёт картинку как data:URL — принимаем и такой вид.
      let detectedType = null;
      const dataUrl = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(raw);
      if (dataUrl) {
        if (!dataUrl[2]) throw toolError('EARGS', 'data:URL должен быть в base64 (ожидается «;base64,»)');
        detectedType = dataUrl[1] || null;
        raw = dataUrl[3];
      }

      const cleaned = raw.replace(/\s+/g, '');
      // Buffer.from молча игнорирует мусор, поэтому проверяем алфавит сами.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
        throw toolError('EARGS', 'Строка не похожа на base64');
      }
      const buf = Buffer.from(cleaned, 'base64');
      if (!buf.length) throw toolError('EARGS', 'После декодирования получилось 0 байт');
      if (buf.length > MAX_BINARY) {
        throw toolError('ETOOLARGE', `Файл больше ${Math.round(MAX_BINARY / 1048576)} МБ — не приму`);
      }

      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
      return {
        path: rel(root, abs),
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        detectedType,
      };
    }

    case 'make_dir': {
      const abs = jail(args.path);
      await fsp.mkdir(abs, { recursive: true });
      return { path: rel(root, abs) };
    }

    case 'move': {
      const from = jail(args.from);
      const to = jail(args.to);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (isReservedName(from)) {
        const ok = fsExists(from) && (await moveReserved(from, to));
        if (!ok) {
          if (!fsExists(from)) throw toolError('ENOENT', 'Файл не найден: ' + rel(root, from));
          throw toolError('ERESERVED', 'Не удалось переместить «' + path.basename(from) + '». ' + RESERVED_HINT);
        }
        return { from: rel(root, from), to: rel(root, to), viaReserved: true };
      }
      await fsp.rename(from, to);
      return { from: rel(root, from), to: rel(root, to) };
    }

    case 'copy': {
      const from = jail(args.from);
      const to = jail(args.to);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (isReservedName(to)) {
        const cmd = `Copy-Item -LiteralPath ${psQuote(toExtendedPath(from))} -Destination ${psQuote(to)} -Recurse -Force -ErrorAction Stop`;
        const res = await runShell({ shell: 'powershell', command: cmd, timeoutMs: 30000 });
        if (res.exitCode !== 0) throw toolError('ERESERVED', 'Не удалось скопировать в «' + path.basename(to) + '». ' + RESERVED_HINT);
        return { from: rel(root, from), to: rel(root, to), viaReserved: true };
      }
      await fsp.cp(from, to, { recursive: true, force: true });
      return { from: rel(root, from), to: rel(root, to) };
    }

    case 'tree': {
      const base = jail(args.path || '.');
      const maxDepth = Math.min(Math.max(Number(args.depth) || 3, 1), 6);
      const lines = [];
      let dirs = 0;
      let files = 0;
      const rec = async (abs, prefix, depth) => {
        if (depth > maxDepth || lines.length > 400) return;
        let entries;
        try {
          entries = await fsp.readdir(abs, { withFileTypes: true });
        } catch {
          return;
        }
        entries = entries
          .filter((e) => !SKIP_DIRS.has(e.name))
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const last = i === entries.length - 1;
          lines.push(prefix + (last ? '└─ ' : '├─ ') + e.name + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory()) {
            dirs++;
            await rec(path.join(abs, e.name), prefix + (last ? '   ' : '│  '), depth + 1);
          } else {
            files++;
          }
        }
      };
      await rec(base, '', 1);
      return { path: rel(root, base), depth: maxDepth, dirs, files, tree: rel(root, base) + '/\n' + lines.join('\n') };
    }

    case 'read_lines': {
      const abs = jail(args.path);
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      if (st.size > 8 * 1024 * 1024) throw toolError('ETOOLARGE', 'Файл больше 8 МБ — читай через run_command');
      // Снимаем один завершающий перевод строки: иначе у файла «a\nb\n»
      // последней строкой окажется пустая, и tail вернёт пустоту.
      const text = (await fsp.readFile(abs, 'utf8')).replace(/\r?\n$/, '');
      const all = text.split(/\r?\n/);
      const total = all.length;
      let from;
      let to;
      if (args.tail != null) {
        const n = Math.min(Math.max(Number(args.tail) || 50, 1), 2000);
        from = Math.max(0, total - n);
        to = total;
      } else {
        const start = Math.max(Number(args.start) || 1, 1);
        const count = Math.min(Math.max(Number(args.count) || 200, 1), 2000);
        from = start - 1;
        to = Math.min(total, from + count);
      }
      const lines = all.slice(from, to);
      return { path: rel(root, abs), totalLines: total, fromLine: from + 1, toLine: to, lines, content: lines.join('\n') };
    }

    case 'grep': {
      const base = jail(args.path || '.');
      const pattern = String(args.pattern || '');
      if (!pattern) throw toolError('EARGS', 'Параметр pattern обязателен');
      let re;
      try {
        re = new RegExp(pattern, args.ignoreCase ? 'i' : '');
      } catch (e) {
        throw toolError('EARGS', 'Плохое регулярное выражение: ' + e.message);
      }
      const max = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
      const ctx = Math.min(Math.max(Number(args.context) || 0, 0), 10);

      // Фильтр по имени: "*.js" или просто ".md" — проверяем и полный путь, и имя файла.
      const globRaw = String(args.glob || '').trim();
      let globRe = null;
      if (globRaw) {
        const esc = globRaw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        globRe = new RegExp('^' + esc + '$');
      }
      const globOk = (relPath, base) =>
        !globRe || globRe.test(relPath) || globRe.test(base) || relPath.endsWith(globRaw);

      // path может указывать и на файл — тогда walk() не нужен (readdir на файле падает).
      const all = [];
      const baseSt = await fsp.stat(base);
      if (baseSt.isFile()) all.push({ abs: base, name: path.basename(base), dir: false });
      else await walk(base, 0, all);
      const matches = [];
      let scanned = 0;
      for (const item of all) {
        if (item.dir || matches.length >= max) continue;
        const relPath = rel(root, item.abs);
        if (!globOk(relPath, item.name)) continue;
        scanned++;
        let text;
        try {
          const buf = await fsp.readFile(item.abs);
          if (buf.length > 512 * 1024) continue;
          text = buf.toString('utf8');
        } catch {
          continue;
        }
        // Как и в read_lines: без этого у файла с переводом строки в конце
        // появляется лишняя пустая строка, и она попадает в context.
        const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          const hit = { file: relPath, line: i + 1, text: lines[i].trim().slice(0, 300) };
          if (ctx) {
            hit.before = lines.slice(Math.max(0, i - ctx), i).map((t, k) => ({ n: i - ctx + k + 1, text: t.slice(0, 300) }));
            hit.after = lines.slice(i + 1, i + 1 + ctx).map((t, k) => ({ n: i + k + 2, text: t.slice(0, 300) }));
          }
          matches.push(hit);
          if (matches.length >= max) break;
        }
      }
      return { pattern, glob: globRaw || null, context: ctx, scannedFiles: scanned, matches };
    }

    case 'hash': {
      const abs = jail(args.path);
      const algo = String(args.algo || 'sha256').toLowerCase();
      if (!HASHES.has(algo)) throw toolError('EARGS', 'Поддерживаются: ' + [...HASHES].join(', '));
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      const hash = await new Promise((resolve, reject) => {
        const h = crypto.createHash(algo);
        const stream = createReadStream(abs);
        stream.on('data', (d) => h.update(d));
        stream.on('end', () => resolve(h.digest('hex')));
        stream.on('error', reject);
      });
      return { path: rel(root, abs), algo, bytes: st.size, hash };
    }

    case 'diff': {
      const aAbs = jail(args.pathA);
      const bAbs = jail(args.pathB);
      const aSt = await fsp.stat(aAbs);
      const bSt = await fsp.stat(bAbs);
      if (aSt.isDirectory() || bSt.isDirectory()) throw toolError('EISDIR', 'diff сравнивает файлы, а не папки');
      if (aSt.size > 8 * 1024 * 1024 || bSt.size > 8 * 1024 * 1024) {
        throw toolError('ETOOLARGE', 'Файл больше 8 МБ — сравнивай через run_command (git diff --no-index)');
      }
      const a = await fsp.readFile(aAbs, 'utf8');
      const b = await fsp.readFile(bAbs, 'utf8');
      const d = unifiedDiff(a, b, args.context);
      return { pathA: rel(root, aAbs), pathB: rel(root, bAbs), ...d };
    }

    case 'diff_git': {
      const abs = jail(args.path);
      const rev = args.rev != null && String(args.rev).trim() !== '' ? String(args.rev) : null;
      const ctx = Math.max(0, Math.min(Number(args.context) || 3, 10));
      const gitArgs = ['diff', '--no-color', '-U' + ctx];
      if (rev) gitArgs.push(rev);
      gitArgs.push('--', rel(root, abs));
      const res = await runProcess({
        file: process.platform === 'win32' ? 'git.exe' : 'git',
        args: gitArgs,
        cwd: root,
        timeoutMs: args.timeoutMs,
      });
      if (res.error) throw toolError('EGIT', res.error + (res.error.includes('ENOENT') ? ' — git не найден в PATH' : ''));
      if (res.exitCode !== 0 && !res.stdout.trim()) {
        throw toolError('EGIT', (res.stderr || 'git diff не сработал').trim().slice(0, 400));
      }
      return {
        path: rel(root, abs),
        rev: rev || '(рабочее дерево)',
        exitCode: res.exitCode,
        changed: res.stdout.trim().length > 0,
        diff: res.stdout,
        stderr: res.stderr ? res.stderr.trim().slice(0, 400) : undefined,
      };
    }

    case 'image_info': {
      const abs = jail(args.path);
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не картинка');
      const buf = await fsp.readFile(abs);
      const info = imageInfoFromBuffer(buf);
      if (!info.format) throw toolError('EIMAGE', 'Не похоже на png / jpeg / gif / bmp / webp');
      return {
        path: rel(root, abs),
        format: info.format,
        width: info.width,
        height: info.height,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
      };
    }

    case 'find_tool': {
      return await findToolPaths(args.name);
    }

    case 'sysinfo': {
      const info = {
        platform: process.platform,
        arch: process.arch,
        os: os.type() + ' ' + os.release(),
        hostname: os.hostname(),
        user: os.userInfo().username,
        node: process.version,
        cpuCount: os.cpus().length,
        cpuModel: (os.cpus()[0] || {}).model || null,
        memoryTotalMB: Math.round(os.totalmem() / 1048576),
        memoryFreeMB: Math.round(os.freemem() / 1048576),
        systemUptimeMin: Math.round(os.uptime() / 60),
        workspace: cfg.workspaceRoot,
      };
      try {
        const st = await fsp.statfs(cfg.workspaceRoot);
        info.diskFreeGB = Math.round((st.bavail * st.bsize) / 1073741824);
        info.diskTotalGB = Math.round((st.blocks * st.bsize) / 1073741824);
      } catch {
        // statfs не поддержан — пропускаем
      }
      return info;
    }

    case 'zip': {
      const srcAbs = jail(args.path || '.');
      const dstAbs = jail(args.dest || 'archive.zip');
      const st = await fsp.stat(srcAbs);
      await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
      const srcSlash = srcAbs.split(path.sep).join('/');
      const dstSlash = dstAbs.split(path.sep).join('/');
      // Для папки нужен wildcard (Path), для файла — LiteralPath.
      const cmd = st.isDirectory()
        ? `Compress-Archive -Path ${psQuote(srcSlash + '/*')} -DestinationPath ${psQuote(dstSlash)} -Force`
        : `Compress-Archive -LiteralPath ${psQuote(srcSlash)} -DestinationPath ${psQuote(dstSlash)} -Force`;
      const res = await runShell({ shell: 'powershell', command: cmd, cwd: root, timeoutMs: 120000 });
      if (res.exitCode !== 0) throw toolError('EZIP', (res.stderr || 'Compress-Archive не сработал').trim().slice(0, 400));
      const out = await fsp.stat(dstAbs);
      return { archive: rel(root, dstAbs), bytes: out.size, source: rel(root, srcAbs) };
    }

    case 'unzip': {
      const srcAbs = jail(args.path);
      const dstAbs = jail(args.dest || '.');
      await fsp.mkdir(dstAbs, { recursive: true });
      const srcSlash = srcAbs.split(path.sep).join('/');
      const dstSlash = dstAbs.split(path.sep).join('/');
      const cmd = `Expand-Archive -LiteralPath ${psQuote(srcSlash)} -DestinationPath ${psQuote(dstSlash)} -Force`;
      const res = await runShell({ shell: 'powershell', command: cmd, cwd: root, timeoutMs: 120000 });
      if (res.exitCode !== 0) throw toolError('EUNZIP', (res.stderr || 'Expand-Archive не сработал').trim().slice(0, 400));
      return { archive: rel(root, srcAbs), dest: rel(root, dstAbs) };
    }

    case 'list_windows': {
      const script = screenshotScriptPath();
      const res = await runShell({ shell: 'powershell', command: `& ${psQuote(script)} -Mode list`, timeoutMs: 30000 });
      if (res.exitCode !== 0) throw toolError('EWIN', (res.stderr || 'не удалось получить список окон').trim().slice(0, 300));
      let parsed;
      try {
        parsed = JSON.parse(res.stdout.trim() || '[]');
      } catch {
        throw toolError('EWIN', 'не удалось разобрать ответ: ' + res.stdout.slice(0, 200));
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      // handle — HWND: передай его в screenshot { handle }, чтобы снять ровно это
      // окно, а не угадывать заголовок.
      return {
        count: list.length,
        windows: list.map((w) => ({ process: w.process, title: w.title, handle: w.handle, pid: w.id })),
      };
    }

    case 'screenshot': {
      const isPage = args.url != null && String(args.url).trim() !== '';
      const outRel = args.path || `screenshots/${isPage ? 'page' : 'shot'}-${Date.now()}.png`;
      const abs = jail(outRel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });

      // Страница: локальный файл рабочей папки или адрес. Локальный рендерим
      // без сети — именно этот случай нужен, чтобы «увидеть» собранный html.
      if (isPage) {
        const raw = String(args.url).trim();
        let target;
        let mode;
        if (/^https?:\/\//i.test(raw)) {
          if (!cfg.allowNetwork) {
            throw toolError('EDISABLED', 'Скриншот страницы по адресу требует allowNetwork — включи сетевой доступ в настройках моста');
          }
          target = raw;
          mode = 'page-remote';
        } else {
          const relPath = decodeURIComponent(raw.replace(/^file:\/\//i, '').replace(/^\/+/, ''));
          const pageAbs = jail(relPath);
          try {
            const st = await fsp.stat(pageAbs);
            if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не страница');
          } catch (e) {
            if (e.code === 'ENOENT') throw toolError('ENOENT', 'Страница не найдена: ' + relPath);
            throw e;
          }
          // file:///C:/... — именно три слэша: два от схемы и один перед диском.
          target = 'file:///' + pageAbs.split(path.sep).join('/');
          mode = 'page-local';
        }
        const shot = await screenshotPage({
          url: target,
          abs,
          width: args.width,
          height: args.height,
          waitMs: args.waitMs,
          timeoutMs: args.timeoutMs,
          fullPage: args.fullPage === true,
          dark: args.dark === true,
          device: args.device,
        });
        return {
          path: rel(root, abs),
          bytes: shot.bytes,
          mode,
          url: raw,
          width: shot.width,
          height: shot.height,
          browser: shot.browser,
          fullPage: args.fullPage === true,
          dark: args.dark === true,
          device: shot.device || null,
        };
      }

      const script = screenshotScriptPath();
      const outSlash = abs.split(path.sep).join('/');
      const wantWindow = args.window || args.process || args.handle != null;
      const parts = [
        `& ${psQuote(script)} -Mode ${wantWindow ? 'window' : 'screen'}`,
        '-Out',
        psQuote(outSlash),
      ];
      if (args.window) parts.push('-Match', psQuote(args.window));
      if (args.process) parts.push('-Process', psQuote(args.process));
      if (args.handle != null && args.handle !== '') parts.push('-Handle', String(Math.trunc(Number(args.handle))));
      if (args.foreground === true) parts.push('-Foreground');
      const cmd = parts.join(' ');
      const res = await runShell({ shell: 'powershell', command: cmd, timeoutMs: 45000 });
      if (res.exitCode !== 0) throw toolError('ESHOT', (res.stderr || 'скриншот не удался').trim().slice(0, 300));
      const st = await fsp.stat(abs);
      return { path: rel(root, abs), bytes: st.size, mode: args.window ? 'window' : 'screen', window: args.window || null };
    }

    case 'python': {
      if (!cfg.allowCommands) throw toolError('EDISABLED', 'Выполнение команд выключено в настройках моста');
      const code = String(args.code || '');
      if (!code.trim()) throw toolError('EARGS', 'Параметр code обязателен');
      const cwd = jail(args.cwd || '.');
      const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
      let exe = null;
      for (const name of candidates) {
        const found = await findToolPaths(name);
        if (found.found.length) {
          exe = found.found[0].path;
          break;
        }
      }
      if (!exe) throw toolError('ENOPY', 'Python не найден. Установи Python или используй run_command.');
      const scriptArgs = Array.isArray(args.args) ? args.args.map((a) => String(a)) : [];
      // PYTHONUTF8/PYTHONIOENCODING: без них Python на Windows пишет в cp1251/cp866,
      // а мост читает stdout как UTF-8 — кириллица превращается в мусор.
      const out = await runProcess({
        file: exe,
        args: ['-c', code, ...scriptArgs],
        cwd,
        timeoutMs: args.timeoutMs,
        stdin: args.stdin,
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      if (out.error) throw toolError('EPYTHON', out.error);
      return { ...out, cwd: rel(root, cwd), python: exe.split(path.sep).join('/') };
    }

    case 'run_command': {
      if (!cfg.allowCommands) throw toolError('EDISABLED', 'Выполнение команд выключено в настройках моста');
      const command = String(args.command || '').trim();
      if (!command) throw toolError('EARGS', 'Параметр command обязателен');
      const shell = String(args.shell || 'powershell').toLowerCase();
      if (!SHELLS.has(shell)) throw toolError('EARGS', 'Неподдерживаемая оболочка: ' + shell);
      const cwd = jail(args.cwd || '.');
      const envRaw = args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : undefined;
      const env = envRaw ? expandEnvValues(envRaw) : undefined;
      const out = await runShell({ shell, command, cwd, timeoutMs: args.timeoutMs, env });
      if (out.error) throw toolError('ESHELL', out.error);
      return { ...out, cwd: rel(root, cwd), envKeys: env ? Object.keys(env) : [] };
    }

    case 'git': {
      const sub = String(args.subcommand || '').trim().toLowerCase();
      if (!sub) throw toolError('EARGS', 'Параметр subcommand обязателен');
      if (!GIT_READ.has(sub) && !GIT_WRITE.has(sub)) {
        throw toolError(
          'EARGS',
          `Подкоманда «${sub}» не поддерживается. Доступно: ` + [...GIT_READ, ...GIT_WRITE].sort().join(', '),
        );
      }
      if (GIT_WRITE.has(sub) && !cfg.allowCommands) {
        throw toolError('EDISABLED', `git ${sub} меняет состояние — включи «Выполнение команд» в настройках моста`);
      }
      const extra = (Array.isArray(args.args) ? args.args : args.args == null ? [] : [args.args]).map(String);
      for (const a of extra) {
        if (GIT_BLOCKED_ARG.has(a)) throw toolError('EARGS', 'Аргумент не поддерживается: ' + a);
      }
      const cwd = jail(args.cwd || '.');
      const res = await runProcess({
        file: process.platform === 'win32' ? 'git.exe' : 'git',
        args: [sub, ...extra],
        cwd,
        timeoutMs: args.timeoutMs,
      });
      if (res.error) throw toolError('EGIT', res.error + (res.error.includes('ENOENT') ? ' — git не найден в PATH' : ''));
      return { subcommand: sub, args: extra, cwd: rel(root, cwd), exitCode: res.exitCode, timedOut: res.timedOut, stdout: res.stdout, stderr: res.stderr };
    }

    case 'start_process': {
      if (!cfg.allowCommands) throw toolError('EDISABLED', 'Запуск процессов выключен в настройках моста');
      const command = String(args.command || '').trim();
      if (!command) throw toolError('EARGS', 'Параметр command обязателен');
      const shell = String(args.shell || 'powershell').toLowerCase();
      if (!SHELLS.has(shell)) throw toolError('EARGS', 'Неподдерживаемая оболочка: ' + shell);
      const cwd = jail(args.cwd || '.');
      const envRaw = args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : undefined;
      const env = envRaw ? expandEnvValues(envRaw) : undefined;

      // Сначала выкидываем завершённые, и только потом решаем, есть ли место.
      if (processes.size >= MAX_PROCESSES) {
        for (const [pid, entry] of processes) {
          if (!entry.running) processes.delete(pid);
          if (processes.size < MAX_PROCESSES) break;
        }
      }
      if (processes.size >= MAX_PROCESSES) {
        throw toolError('ELIMIT', `Уже запущено ${processes.size} процессов — останови лишние через kill_process`);
      }

      const spawned = spawnBackground({ shell, command, cwd, env });
      if (spawned.error) throw toolError('ESHELL', spawned.error);

      // Важно: дописываем поля прямо в живой state, а не через spread — копия
      // заморозила бы running/exitCode на момент старта, и процесс навсегда
      // оставался бы «живым».
      const id = nextProcessId++;
      const entry = spawned.state;
      entry.id = id;
      entry.name = String(args.name || `${shell}-${id}`);
      entry.command = command;
      entry.cwd = rel(root, cwd);
      processes.set(entry.pid, entry);

      // Если команда не существует, процесс умрёт за ~600 мс. Ждём до 1200 мс,
      // но выходим раньше, как только он умер: лучше сказать об этом сейчас,
      // чем отдать pid, который уже мёртв.
      const deadline = Date.now() + 1200;
      while (entry.running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 60));
      }
      return {
        pid: entry.pid,
        name: entry.name,
        shell,
        cwd: entry.cwd,
        running: entry.running,
        exitCode: entry.exitCode,
        stderrTail: (shell === 'powershell' || shell === 'pwsh' ? decodeClixml(entry.stderr) : entry.stderr).slice(-1000),
      };
    }

    case 'list_processes': {
      const list = [...processes.values()].map(processView);
      return {
        count: list.length,
        running: list.filter((p) => p.running).length,
        processes: list,
      };
    }

    case 'kill_process': {
      if (!cfg.allowCommands) throw toolError('EDISABLED', 'Управление процессами выключено в настройках моста');
      const entry = findProcess({ pid: args.pid, name: args.name });
      if (!entry) throw toolError('ENOPROC', 'Процесс не найден: ' + (args.pid != null ? args.pid : args.name));
      if (!entry.running) {
        processes.delete(entry.pid);
        return { pid: entry.pid, name: entry.name, alreadyStopped: true, exitCode: entry.exitCode };
      }
      killTree(entry.pid);
      // taskkill /F срабатывает не мгновенно: событие close приходит примерно
      // через секунду после команды, поэтому ждём с запасом.
      const deadline = Date.now() + 3000;
      while (entry.running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
      }
      if (entry.running) {
        return { pid: entry.pid, name: entry.name, stopped: false, note: 'процесс ещё жив — повтори kill_process' };
      }
      processes.delete(entry.pid);
      return { pid: entry.pid, name: entry.name, stopped: true, exitCode: entry.exitCode };
    }

    case 'download': {
      if (!cfg.allowNetwork) throw toolError('EDISABLED', 'Сетевой доступ выключен — включи allowNetwork в настройках моста');
      const url = String(args.url || '').trim();
      if (!url) throw toolError('EARGS', 'Параметр url обязателен');

      let relPath = args.path ? String(args.path) : '';
      if (!relPath) {
        let guess = '';
        try {
          guess = path.basename(new URL(url).pathname);
        } catch {
          guess = '';
        }
        relPath = guess || 'download.bin';
      }
      const abs = jail(relPath);
      await fsp.mkdir(path.dirname(abs), { recursive: true });

      const out = await downloadTo({ url, abs, timeoutMs: args.timeoutMs, maxBytes: args.maxBytes });
      const hash = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const stream = createReadStream(abs);
        stream.on('data', (d) => h.update(d));
        stream.on('end', () => resolve(h.digest('hex')));
        stream.on('error', reject);
      });
      return { url, path: rel(root, abs), bytes: out.bytes, contentType: out.contentType, sha256: hash };
    }

    case 'http_get':
    case 'http_post': {
      if (!cfg.allowNetwork) throw toolError('EDISABLED', 'Сетевой доступ выключен — включи allowNetwork в настройках моста');
      const url = String(args.url || '').trim();
      if (!url) throw toolError('EARGS', 'Параметр url обязателен');
      const isPost = name === 'http_post';
      const headers = args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers) ? { ...args.headers } : {};

      let body = args.body;
      if (isPost && body != null) {
        if (typeof body === 'object') body = JSON.stringify(body);
        const hasType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (!hasType) headers['Content-Type'] = String(args.contentType || 'application/json');
      }
      return await httpRequest({
        url,
        method: isPost ? 'POST' : 'GET',
        headers,
        body: isPost ? body : undefined,
        timeoutMs: args.timeoutMs,
      });
    }

    case 'delete': {
      const abs = jail(args.path);
      if (rel(root, abs) === '.') throw toolError('EROOT', 'Нельзя удалить саму рабочую папку');
      const trash = path.join(root, '.trash');
      await fsp.mkdir(trash, { recursive: true });
      const dest = path.join(trash, `${Date.now()}_${path.basename(abs)}`);
      if (isReservedName(abs)) {
        // В .trash такое имя не переносится: Windows считает его устройством, а не
        // файлом. Пробуем удалить напрямую через PowerShell с префиксом \\?\.
        const existed = fsExists(abs);
        const ok = existed && (await removeReserved(abs));
        if (!ok) {
          if (!existed) throw toolError('ENOENT', 'Файл не найден: ' + rel(root, abs));
          throw toolError('ERESERVED', 'Не удалось удалить «' + path.basename(abs) + '». ' + RESERVED_HINT);
        }
        return {
          original: rel(root, abs),
          removed: true,
          viaReserved: true,
          note: 'имя зарезервировано Windows — удалено напрямую, в .trash не переносилось',
        };
      }
      await fsp.rename(abs, dest);
      return { trashed: rel(root, dest), original: rel(root, abs) };
    }

    case 'stat': {
      const abs = jail(args.path);
      const st = await fsp.stat(abs);
      return {
        path: rel(root, abs),
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
        reservedName: isReservedName(abs) || undefined,
      };
    }

    case 'search': {
      const base = jail(args.path || '.');
      const q = String(args.query || '').toLowerCase();
      if (!q) throw toolError('EARGS', 'Параметр query обязателен');
      const all = [];
      await walk(base, 0, all);
      const matches = [];
      for (const item of all) {
        if (item.dir) continue;
        let hit = item.name.toLowerCase().includes(q);
        if (!hit) {
          try {
            const buf = await fsp.readFile(item.abs);
            if (buf.length < 256 * 1024 && buf.toString('utf8').toLowerCase().includes(q)) hit = true;
          } catch {
            hit = false;
          }
        }
        if (hit) {
          matches.push(rel(root, item.abs));
          if (matches.length >= SEARCH_RESULTS) break;
        }
      }
      return { query: args.query, scanned: all.length, matches };
    }

    case 'read_around': {
      const abs = jail(args.path);
      const pattern = String(args.pattern || '');
      if (!pattern) throw toolError('EARGS', 'Параметр pattern обязателен');
      let re;
      try {
        re = new RegExp(pattern, args.ignoreCase ? 'i' : '');
      } catch (e) {
        throw toolError('EARGS', 'Плохое регулярное выражение: ' + e.message);
      }
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw toolError('EISDIR', 'Это директория, а не файл');
      if (st.size > 8 * 1024 * 1024) throw toolError('ETOOLARGE', 'Файл больше 8 МБ — читай через run_command');
      const before = Math.min(Math.max(Number(args.before ?? 20) || 0, 0), 500);
      const after = Math.min(Math.max(Number(args.after ?? 20) || 0, 0), 500);
      const hit = Math.max(Number(args.hit) || 1, 1);
      const text = (await fsp.readFile(abs, 'utf8')).replace(/\r?\n$/, '');
      const all = text.split(/\r?\n/);
      // Собираем все вхождения сразу: модели важно знать, сколько их всего, —
      // иначе она читает «первое» и не подозревает, что их двадцать.
      const found = [];
      for (let i = 0; i < all.length; i++) if (re.test(all[i])) found.push(i);
      if (!found.length) {
        return { path: rel(root, abs), pattern, totalLines: all.length, matches: 0, lines: [], content: '' };
      }
      const idx = found[Math.min(hit, found.length) - 1];
      const from = Math.max(0, idx - before);
      const to = Math.min(all.length, idx + after + 1);
      const lines = all.slice(from, to).map((t, k) => ({ n: from + k + 1, text: t.slice(0, 500) }));
      return {
        path: rel(root, abs),
        pattern,
        totalLines: all.length,
        matches: found.length,
        hitIndex: Math.min(hit, found.length),
        hitLine: idx + 1,
        matchesAt: found.slice(0, 50).map((n) => n + 1),
        fromLine: from + 1,
        toLine: to,
        lines,
        content: lines.map((l) => l.text).join('\n'),
      };
    }

    case 'batch': {
      const calls = Array.isArray(args.calls) ? args.calls : null;
      if (!calls) throw toolError('EARGS', 'Параметр calls обязателен — массив [{ tool, args }]');
      if (!calls.length) throw toolError('EARGS', 'calls пуст');
      if (calls.length > MAX_BATCH) {
        throw toolError('ELIMIT', `В batch максимум ${MAX_BATCH} вызовов, получено ${calls.length}`);
      }
      if (depth > MAX_BATCH_DEPTH) throw toolError('EBATCHNEST', 'batch внутри batch запрещён');
      const stopOnError = args.stopOnError === true;
      const results = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i] && typeof calls[i] === 'object' ? calls[i] : {};
        const tool = typeof call.tool === 'string' ? call.tool : '';
        if (!tool) {
          results.push({ index: i, ok: false, tool: null, error: { code: 'EARGS', message: 'Нужен tool (строка)' } });
          if (stopOnError) break;
          continue;
        }
        if (tool === 'batch') {
          results.push({ index: i, ok: false, tool, error: { code: 'EBATCHNEST', message: 'batch внутри batch запрещён' } });
          if (stopOnError) break;
          continue;
        }
        const started = Date.now();
        try {
          const result = await runToolInner(cfg, tool, call.args && typeof call.args === 'object' ? call.args : {}, depth + 1);
          recordUsage(tool, true, Date.now() - started);
          results.push({ index: i, ok: true, tool, result });
        } catch (e) {
          recordUsage(tool, false, Date.now() - started);
          results.push({ index: i, ok: false, tool, error: { code: e.code || 'EUNKNOWN', message: e.message } });
          if (stopOnError) break;
        }
      }
      return {
        count: calls.length,
        done: results.length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    }

    case 'remember': {
      const key = String(args.key || '').trim();
      if (!key) throw toolError('EARGS', 'Параметр key обязателен');
      const mem = readMemoryFile();
      if (!(key in mem) && Object.keys(mem).length >= MEMORY_MAX_KEYS) {
        throw toolError('ELIMIT', `В памяти уже ${MEMORY_MAX_KEYS} ключей — удали ненужные через forget`);
      }
      const entry = { value: args.value === undefined ? null : args.value, at: new Date().toISOString() };
      const ttl = Number(args.ttl);
      if (Number.isFinite(ttl) && ttl > 0) entry.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      mem[key] = entry;
      writeMemoryFile(mem);
      return {
        key,
        stored: true,
        keys: Object.keys(mem).length,
        expiresAt: entry.expiresAt || null,
        file: MEMORY_PATH.split(path.sep).join('/'),
      };
    }

    case 'recall': {
      const mem = readMemoryFile();
      const now = Date.now();
      let expiredRemoved = 0;
      for (const [k, v] of Object.entries(mem)) {
        if (v && v.expiresAt && Date.parse(v.expiresAt) <= now) {
          delete mem[k];
          expiredRemoved++;
        }
      }
      if (expiredRemoved) writeMemoryFile(mem);

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      let items;
      if (args.key != null && String(args.key) !== '') {
        const key = String(args.key);
        items = key in mem ? [[key, mem[key]]] : [];
      } else if (args.pattern != null && String(args.pattern) !== '') {
        const raw = String(args.pattern);
        let re = null;
        try {
          re = new RegExp(raw, 'i');
        } catch {
          re = null;
        }
        items = Object.entries(mem).filter(([k, v]) =>
          re ? re.test(k) || re.test(String(v && v.value)) : k.toLowerCase().includes(raw.toLowerCase()),
        );
      } else {
        items = Object.entries(mem);
      }
      items.sort((a, b) => String(b[1] && b[1].at).localeCompare(String(a[1] && a[1].at)));
      return {
        total: items.length,
        count: Math.min(items.length, limit),
        expiredRemoved,
        entries: items.slice(0, limit).map(([k, v]) => ({
          key: k,
          value: v && v.value,
          at: (v && v.at) || null,
          expiresAt: (v && v.expiresAt) || null,
        })),
      };
    }

    case 'forget': {
      if (args.all === true) {
        const cleared = Object.keys(readMemoryFile()).length;
        writeMemoryFile({});
        return { cleared };
      }
      const key = String(args.key || '').trim();
      if (!key) throw toolError('EARGS', 'Параметр key обязателен (или all: true)');
      const mem = readMemoryFile();
      if (!(key in mem)) return { key, removed: false, note: 'такого ключа нет' };
      delete mem[key];
      writeMemoryFile(mem);
      return { key, removed: true, keys: Object.keys(mem).length };
    }

    case 'usage_stats': {
      const sort = String(args.sort || 'total').toLowerCase();
      const pick = {
        calls: (u) => u.calls,
        errors: (u) => u.errors,
        avg: (u) => u.avgMs,
        max: (u) => u.maxMs,
        total: (u) => u.totalMs,
      }[sort] || ((u) => u.totalMs);
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
      const all = [...usage.entries()].map(([name, u]) => ({
        tool: name,
        calls: u.calls,
        errors: u.errors,
        totalMs: u.totalMs,
        avgMs: u.calls ? Math.round((u.totalMs / u.calls) * 10) / 10 : 0,
        maxMs: u.maxMs,
        lastAt: u.lastAt,
      }));
      all.sort((a, b) => pick(b) - pick(a) || a.tool.localeCompare(b.tool));
      const out = {
        sort,
        uptimeSec: Math.round(process.uptime()),
        toolsUsed: all.length,
        totals: all.reduce(
          (acc, r) => ({ calls: acc.calls + r.calls, errors: acc.errors + r.errors, totalMs: acc.totalMs + r.totalMs }),
          { calls: 0, errors: 0, totalMs: 0 },
        ),
        stats: all.slice(0, limit),
      };
      // Сброс — осознанное действие: после него статистика начинается заново,
      // а сам вызов usage_stats в неё уже не попадёт.
      if (args.reset === true) {
        usage.clear();
        out.reset = true;
      }
      return out;
    }

    case 'process_logs': {
      const entry = findProcess({ pid: args.pid, name: args.name });
      if (!entry) throw toolError('ENOPROC', 'Процесс не найден: ' + (args.pid != null ? args.pid : args.name));

      if (args.clear === true) {
        entry.stdout = '';
        entry.stderr = '';
        return { pid: entry.pid, name: entry.name, cleared: true, nextOffset: { stdout: 0, stderr: 0 } };
      }

      const tail = Math.min(Math.max(Number(args.tail) || 100, 1), 2000);
      const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), 30000);
      const waitStarted = Date.now();

      // Аналог tail -f: ждём нового вывода, но не дольше waitMs и не дольше
      // жизни процесса. Возвращаемся сразу, как только что-то появилось.
      const mark = { stdout: entry.stdout.length, stderr: entry.stderr.length };
      if (waitMs > 0) {
        const deadline = waitStarted + waitMs;
        while (Date.now() < deadline) {
          if (entry.stdout.length > mark.stdout || entry.stderr.length > mark.stderr) break;
          if (!entry.running) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // since: число — смещение stdout; объект { stdout, stderr } — по каждому
      // потоку своё. Считаем по СЫРЫМ буферам: decodeClixml меняет длину текста,
      // и смещение, снятое после разбора, не совпало бы с реальным.
      const sinceFor = (stream) => {
        const s = args.since;
        if (s == null || s === '') return null;
        if (typeof s === 'object' && !Array.isArray(s)) {
          const v = s[stream];
          return v == null || v === '' ? null : Number(v);
        }
        return stream === 'stdout' ? Number(s) : null;
      };
      const hasSince = args.since != null && args.since !== '';
      const fallback = waitMs > 0 ? mark : null;

      const cut = (raw, stream) => {
        const s = hasSince ? sinceFor(stream) : fallback ? fallback[stream] : null;
        return sliceFrom(raw, s);
      };
      const outSlice = cut(entry.stdout, 'stdout');
      const errSlice = cut(entry.stderr, 'stderr');
      const errText = entry.shell === 'powershell' || entry.shell === 'pwsh'
        ? decodeClixml(errSlice.text)
        : errSlice.text;

      const takeTail = (text) => {
        if (!text) return '';
        const lines = text.replace(/\n$/, '').split(/\r?\n/);
        return lines.length <= tail ? text : lines.slice(-tail).join('\n');
      };
      const countLines = (text) => (text ? text.replace(/\n$/, '').split(/\r?\n/).length : 0);

      const stdout = takeTail(outSlice.text);
      const stderr = takeTail(errText);
      return {
        pid: entry.pid,
        name: entry.name,
        running: entry.running,
        exitCode: entry.exitCode,
        durationMs: (entry.endedAt || Date.now()) - entry.startedAt,
        waitedMs: Date.now() - waitStarted,
        stdout,
        stderr,
        stdoutLines: countLines(stdout),
        stderrLines: countLines(stderr),
        // true — буфер успел обрезаться сверху, и since больше не совпадает
        // с позицией в тексте: курсор сбрасывается, отдаём весь хвост.
        truncated: outSlice.truncated || errSlice.truncated,
        nextOffset: { stdout: entry.stdout.length, stderr: entry.stderr.length },
      };
    }

    default:
      throw toolError('ENOTOOL', 'Неизвестный инструмент: ' + name);
  }
}

// Обёртка ради метрик: считаем и успех, и ошибку, и время. batch вызывает
// runToolInner напрямую, поэтому его под-вызовы попадают в статистику каждый
// сам по себе, а не одним «batch».
export async function runTool(cfg, name, args = {}) {
  const started = Date.now();
  try {
    const result = await runToolInner(cfg, name, args);
    recordUsage(name, true, Date.now() - started);
    return result;
  } catch (e) {
    recordUsage(name, false, Date.now() - started);
    throw e;
  }
}
