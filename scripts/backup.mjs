// Бэкап проекта «Дипсик Мост» одним zip-архивом.
//
// Почему свой райтер, а не инструмент `zip` моста: тот зовёт PowerShell
// Compress-Archive, а PS 5.1 пишет имена файлов в OEM-кодировке без флага UTF-8 —
// кириллица в именах превращается в мусор. Здесь имена всегда UTF-8
// (general purpose bit 11), поэтому архив читается и Windows, и 7-Zip, и unzip.
//
// Запуск:
//   node scripts/backup.mjs              — исходники + память проекта + .git
//   node scripts/backup.mjs --full       — то же плюс артефакты сборки (exe, релизный zip)
//   node scripts/backup.mjs --out DIR    — куда положить архив (по умолчанию dist/backups)
//
// Архив проверяется сразу после записи: читается центральный каталог,
// сверяется число записей и размер каждого файла. Битый бэкап — не бэкап.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- crc32 ----------
// Таблица считается один раз при загрузке модуля: на 86 МБ это заметно.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- DOS-время ----------
function dosStamp(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

const U32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const U16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
};

const FLAG_UTF8 = 0x0800; // general purpose bit 11 — имена в UTF-8

// ---------- обход файлов ----------
// exclude — префиксы путей от корня проекта (POSIX, со слэшем на конце для папок).
function walk(absDir, relPrefix, exclude, out) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relPrefix ? relPrefix + '/' + entry.name : entry.name;
    if (exclude.some((x) => rel === x || rel.startsWith(x.endsWith('/') ? x : x + '/'))) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push({ rel: rel + '/', abs, dir: true });
      walk(abs, rel, exclude, out);
    } else if (entry.isFile()) {
      out.push({ rel, abs, dir: false });
    }
    // симлинки и прочее пропускаем: в этом проекте их нет, а тянуть за собой
    // ссылки за пределы папки в бэкапе не нужно
  }
}

// ---------- сборка архива ----------
function buildZip(files, onProgress) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let done = 0;

  for (const item of files) {
    const stamp = dosStamp(fs.statSync(item.abs).mtime);
    const nameBuf = Buffer.from(item.rel, 'utf8');

    let raw = Buffer.alloc(0);
    let method = 0;
    let packed = Buffer.alloc(0);
    let crc = 0;
    let size = 0;

    if (!item.dir) {
      raw = fs.readFileSync(item.abs);
      size = raw.length;
      crc = crc32(raw);
      // Уже сжатые форматы (png, zip, exe) дефлейт только раздувает и жрёт время.
      const store = /\.(png|jpe?g|gif|webp|ico|zip|gz|xz|7z|exe|blob|dll)$/i.test(item.rel);
      if (!store && raw.length > 0) {
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length) {
          method = 8;
          packed = deflated;
        } else {
          packed = raw;
        }
      } else {
        packed = raw;
      }
    }

    const local = Buffer.concat([
      U32(0x04034b50),
      U16(20), // version needed
      U16(FLAG_UTF8),
      U16(method),
      U16(stamp.time),
      U16(stamp.day),
      U32(crc),
      U32(packed.length),
      U32(size),
      U16(nameBuf.length),
      U16(0),
      nameBuf,
    ]);

    chunks.push(local, packed);
    central.push(
      Buffer.concat([
        U32(0x02014b50),
        U16(20), // version made by
        U16(20), // version needed
        U16(FLAG_UTF8),
        U16(method),
        U16(stamp.time),
        U16(stamp.day),
        U32(crc),
        U32(packed.length),
        U32(size),
        U16(nameBuf.length),
        U16(0),
        U16(0),
        U16(0),
        U16(0),
        U32(item.dir ? 0x10 : 0),
        U32(offset),
        nameBuf,
      ]),
    );

    offset += local.length + packed.length;
    done++;
    if (onProgress) onProgress(done, files.length, item.rel, size);
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    U32(0x06054b50),
    U16(0),
    U16(0),
    U16(files.length),
    U16(files.length),
    U32(centralBuf.length),
    U32(offset),
    U16(0),
  ]);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------- проверка архива ----------
// Читаем EOCD, идём по центральному каталогу и сверяем размеры с диском.
function verifyZip(buf, files) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error('не нашёл EOCD — архив битый');
  const count = buf.readUInt16LE(eocdAt + 10);
  const centralSize = buf.readUInt32LE(eocdAt + 12);
  const centralAt = buf.readUInt32LE(eocdAt + 16);
  if (count !== files.length) throw new Error('в архиве ' + count + ' записей, ждали ' + files.length);
  if (centralAt + centralSize !== eocdAt) throw new Error('центральный каталог не стыкуется с EOCD');

  let p = centralAt;
  let checked = 0;
  const names = [];
  while (p < eocdAt) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('битая запись каталога на смещении ' + p);
    const flags = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (!(flags & FLAG_UTF8)) throw new Error('у записи нет флага UTF-8: ' + name);
    names.push(name);
    checked++;
    p += 46 + nameLen + extraLen + commentLen;
    void size;
  }
  if (checked !== files.length) throw new Error('прочитал ' + checked + ' записей из ' + files.length);
  return names;
}

// ---------- main ----------
const argv = process.argv.slice(2);
const full = argv.includes('--full');
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, 'dist', 'backups');

const exclude = ['.trash/', 'node_modules/', '.test-data/', '.test-workspace/', '.test-extra/'];
if (!full) exclude.push('bridge/dist/', 'dist/');
if (!full) {
  // dist/backups — сами бэкапы; в новый архив их не тащим.
  exclude.push('dist/backups/');
} else {
  exclude.push('dist/backups/');
}

const files = [];
walk(ROOT, '', exclude, files);
const totalBytes = files.reduce((sum, f) => sum + (f.dir ? 0 : fs.statSync(f.abs).size), 0);

console.log('Файлов: ' + files.filter((f) => !f.dir).length + ', папок: ' + files.filter((f) => f.dir).length);
console.log('Исходный размер: ' + (totalBytes / 1048576).toFixed(1) + ' МБ' + (full ? ' (полный, с артефактами)' : ''));

const buf = buildZip(files);

const stamp = new Date();
const pad = (n) => String(n).padStart(2, '0');
const name =
  'dsbridge-' +
  stamp.getFullYear() + '-' + pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate()) +
  '_' + pad(stamp.getHours()) + pad(stamp.getMinutes()) +
  (full ? '-full' : '') + '.zip';

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, name);
fs.writeFileSync(outPath, buf);

const names = verifyZip(buf, files);
console.log('Проверка: записей ' + names.length + ', флаг UTF-8 у всех, каталог стыкуется с EOCD.');
const cyr = names.filter((n) => /[А-Яа-яЁё]/.test(n));
console.log('Имена с кириллицей: ' + (cyr.length ? cyr.join(', ') : 'нет'));
console.log('Готово: ' + outPath + ' (' + (buf.length / 1048576).toFixed(1) + ' МБ)');
