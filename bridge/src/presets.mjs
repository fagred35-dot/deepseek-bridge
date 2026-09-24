// Персонажи и скиллы — сохраняемые наборы промптов.
//
// Персонаж (persona) — system-промпт с именем: «Senior Python-разработчик»,
// «Редактор строгих текстов». Пользователь выбирает его в расширении, и текст
// подмешивается к скрытому системному промпту.
//
// Скилл (skill) — шаблон повторяемой задачи: «Сгенерируй React-компонент»,
// «Проверь вёрстку». Хранится с описанием и отдаётся по MCP как prompts —
// тогда любой MCP-клиент видит его как слэш-команду.
//
// Хранилище: ~/.dsbridge/presets.json. Один файл на оба вида — так проще
// бэкапить и переносить. Формат: { personas: {...}, skills: {...} }.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { toolError } from './security.mjs';

export const PRESETS_PATH = path.join(DATA_DIR, 'presets.json');

// \w в JS не покрывает кириллицу — имена вида «Python-разработчик» должны
// проходить, поэтому буквы и цифры берём Unicode-категориями (флаг u).
const NAME_RE = /^[\p{L}\p{N}._\- ]{1,64}$/u;
const MAX_TEXT = 20000;
const MAX_ITEMS = 200;

function readStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
    if (!obj || typeof obj !== 'object') return { personas: {}, skills: {} };
    return {
      personas: obj.personas && typeof obj.personas === 'object' ? obj.personas : {},
      skills: obj.skills && typeof obj.skills === 'object' ? obj.skills : {},
    };
  } catch {
    return { personas: {}, skills: {} };
  }
}

function writeStore(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

function checkName(kind, name) {
  const n = String(name || '').trim();
  if (!n) throw toolError('EARGS', 'Параметр name обязателен');
  if (!NAME_RE.test(n)) {
    throw toolError('EARGS', 'Имя может содержать буквы, цифры, пробел, точку, дефис и подчёркивание (до 64 символов)');
  }
  return n;
}

function checkText(text, field) {
  const t = String(text ?? '');
  if (!t.trim()) throw toolError('EARGS', `Параметр ${field} обязателен`);
  if (t.length > MAX_TEXT) throw toolError('ETOOLARGE', `${field} длиннее ${MAX_TEXT} символов`);
  return t;
}

// ---------- персонажи ----------

export function personaList() {
  const store = readStore();
  return Object.entries(store.personas).map(([name, p]) => ({
    name,
    description: p.description || '',
    chars: (p.text || '').length,
    updatedAt: p.updatedAt || null,
  }));
}

export function personaGet(name) {
  const store = readStore();
  const n = String(name || '').trim();
  const p = store.personas[n];
  if (!p) throw toolError('ENOENT', 'Персонаж не найден: ' + n);
  return { name: n, description: p.description || '', text: p.text, updatedAt: p.updatedAt || null };
}

export function personaSet({ name, text, description }) {
  const n = checkName('persona', name);
  const body = checkText(text, 'text');
  const store = readStore();
  if (!store.personas[n] && Object.keys(store.personas).length >= MAX_ITEMS) {
    throw toolError('ELIMIT', `Больше ${MAX_ITEMS} персонажей хранить нельзя`);
  }
  store.personas[n] = {
    text: body,
    description: String(description || '').slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return { stored: true, name: n, chars: body.length, total: Object.keys(store.personas).length };
}

export function personaDelete(name) {
  const n = String(name || '').trim();
  const store = readStore();
  if (!store.personas[n]) throw toolError('ENOENT', 'Персонаж не найден: ' + n);
  delete store.personas[n];
  writeStore(store);
  return { deleted: true, name: n, total: Object.keys(store.personas).length };
}

// ---------- скиллы ----------

export function skillList() {
  const store = readStore();
  return Object.entries(store.skills).map(([name, s]) => ({
    name,
    description: s.description || '',
    arguments: Array.isArray(s.arguments) ? s.arguments : [],
    chars: (s.text || '').length,
    updatedAt: s.updatedAt || null,
  }));
}

export function skillGet(name) {
  const store = readStore();
  const n = String(name || '').trim();
  const s = store.skills[n];
  if (!s) throw toolError('ENOENT', 'Скилл не найден: ' + n);
  return {
    name: n,
    description: s.description || '',
    text: s.text,
    arguments: Array.isArray(s.arguments) ? s.arguments : [],
    updatedAt: s.updatedAt || null,
  };
}

export function skillSet({ name, text, description, arguments: argDefs }) {
  const n = checkName('skill', name);
  const body = checkText(text, 'text');
  const store = readStore();
  if (!store.skills[n] && Object.keys(store.skills).length >= MAX_ITEMS) {
    throw toolError('ELIMIT', `Больше ${MAX_ITEMS} скиллов хранить нельзя`);
  }
  // Аргументы — как в MCP: [{ name, description, required }]. По ним клиент
  // строит форму подстановки.
  const args = Array.isArray(argDefs)
    ? argDefs
        .filter((a) => a && typeof a.name === 'string' && a.name.trim())
        .map((a) => ({
          name: a.name.trim(),
          description: String(a.description || '').slice(0, 300),
          required: a.required === true,
        }))
        .slice(0, 20)
    : [];
  store.skills[n] = {
    text: body,
    description: String(description || '').slice(0, 500),
    arguments: args,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return { stored: true, name: n, chars: body.length, arguments: args.length, total: Object.keys(store.skills).length };
}

export function skillDelete(name) {
  const n = String(name || '').trim();
  const store = readStore();
  if (!store.skills[n]) throw toolError('ENOENT', 'Скилл не найден: ' + n);
  delete store.skills[n];
  writeStore(store);
  return { deleted: true, name: n, total: Object.keys(store.skills).length };
}

// Рендер скилла с подстановкой аргументов: {{name}} → значение. Незнакомые
// плейсхолдеры остаются как есть — лучше показать их модели, чем молча съесть.
export function skillRender(name, values = {}) {
  const s = skillGet(name);
  // \p{L}/\p{N} вместо \w: имена плейсхолдеров могут быть кириллицей ({{компонент}}).
  const text = s.text.replace(/\{\{\s*([\p{L}\p{N}._\-]+)\s*\}\}/gu, (m, key) => {
    const v = values[key];
    return v === undefined || v === null ? m : String(v);
  });
  return { name: s.name, description: s.description, text, arguments: s.arguments };
}
