// Сетевые операции моста: HTTP-запросы и скачивание файлов.
// Всё это включается только флагом allowNetwork — по умолчанию выключено,
// потому что даёт модели возможность и читать, и отправлять данные наружу.
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toolError } from './security.mjs';

const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 120000;
export const MAX_BODY = 25 * 1024 * 1024; // 25 МБ — потолок и для ответа, и для файла
const MAX_TEXT = 512 * 1024; // текст в ответ инструмента отдаём не больше 512 КБ

const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json)|image\/svg)/i;

export function assertUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw toolError('EBADURL', 'Некорректный URL: ' + raw);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw toolError('EBADURL', 'Поддерживаются только http и https, получено: ' + u.protocol);
  }
  return u;
}

// Заголовки от модели: только плоский объект строка→строка, без служебных.
function cleanHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) continue; // защита от header injection
    out[k.trim()] = String(v);
  }
  return out;
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

function timeoutOf(ms) {
  return Math.min(Math.max(Number(ms) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
}

// Считает байты на лету и рвёт соединение, если ответ больше лимита.
class Limiter extends Transform {
  constructor(max, label) {
    super();
    this.max = max;
    this.label = label;
    this.seen = 0;
  }
  _transform(chunk, _enc, cb) {
    this.seen += chunk.length;
    if (this.seen > this.max) {
      cb(toolError('ETOOLARGE', `${this.label} больше ${Math.round(this.max / 1048576)} МБ — прервано`));
      return;
    }
    cb(null, chunk);
  }
}

async function readCapped(res, max, label) {
  const chunks = [];
  let seen = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += value.length;
    if (seen > max) {
      try {
        await reader.cancel();
      } catch {
        // соединение уже закрыто
      }
      throw toolError('ETOOLARGE', `${label} больше ${Math.round(max / 1048576)} МБ — прервано`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function describeFetchError(e) {
  if (e && e.name === 'TimeoutError') return 'истёк таймаут запроса';
  if (e && e.code === 'ENOTFOUND') return 'хост не найден (DNS)';
  if (e && e.code === 'ECONNREFUSED') return 'соединение отклонено';
  if (e && e.code === 'CERT_HAS_EXPIRED') return 'истёк сертификат TLS';
  return (e && e.message) || 'неизвестная сетевая ошибка';
}

// HTTP-запрос. Текстовые ответы отдаём строкой, бинарные — только метаданными
// (для них есть download).
export async function httpRequest({ url, method = 'GET', headers, body, timeoutMs }) {
  const u = assertUrl(url);
  const m = String(method || 'GET').toUpperCase();
  const hdrs = cleanHeaders(headers);

  let res;
  try {
    res = await fetch(u, {
      method: m,
      headers: hdrs,
      body: body == null ? undefined : String(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutOf(timeoutMs)),
    });
  } catch (e) {
    throw toolError('ENET', describeFetchError(e));
  }

  const contentType = res.headers.get('content-type') || '';
  const declared = Number(res.headers.get('content-length') || 0);
  const isText = TEXTUAL.test(contentType);

  if (!isText) {
    // Тело не читаем вовсе: бинарник нужен через download, а не в чат.
    try {
      await res.body?.cancel();
    } catch {
      // поток уже закрыт
    }
    return {
      url: res.url || u.href,
      status: res.status,
      ok: res.ok,
      contentType,
      bytes: declared || null,
      binary: true,
      note: 'Ответ бинарный — используй download, чтобы сохранить его в файл',
    };
  }

  let buf;
  try {
    buf = await readCapped(res, MAX_BODY, 'Ответ');
  } catch (e) {
    if (e && e.code === 'ETOOLARGE') throw e;
    throw toolError('ENET', 'не удалось прочитать ответ: ' + describeFetchError(e));
  }

  const text = buf.toString('utf8');
  const truncated = text.length > MAX_TEXT;
  return {
    url: res.url || u.href,
    status: res.status,
    ok: res.ok,
    contentType,
    bytes: buf.length,
    truncated,
    headers: headersToObject(res.headers),
    body: truncated ? text.slice(0, MAX_TEXT) : text,
  };
}

// Скачивание в файл рабочей папки. Пишем через временный файл: если сервер
// оборвётся на середине, на месте целевого файла не останется огрызка.
export async function downloadTo({ url, abs, timeoutMs, maxBytes }) {
  const u = assertUrl(url);
  const max = Math.min(Number(maxBytes) || MAX_BODY, MAX_BODY);

  let res;
  try {
    res = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutOf(timeoutMs)),
    });
  } catch (e) {
    throw toolError('ENET', describeFetchError(e));
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // поток уже закрыт
    }
    throw toolError('EHTTP', `Сервер ответил ${res.status} ${res.statusText}`);
  }

  const tmp = abs + '.part';
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      new Limiter(max, 'Файл'),
      fs.createWriteStream(tmp),
    );
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e && e.code === 'ETOOLARGE') throw e;
    throw toolError('ENET', 'загрузка не удалась: ' + describeFetchError(e));
  }

  const st = fs.statSync(tmp);
  if (!st.size) {
    fs.rmSync(tmp, { force: true });
    throw toolError('EEMPTY', 'Сервер вернул пустой ответ');
  }
  fs.renameSync(tmp, abs);
  return { bytes: st.size, contentType: res.headers.get('content-type') || '' };
}
