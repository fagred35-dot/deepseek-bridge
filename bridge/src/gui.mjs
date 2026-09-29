// Управление чужими окнами: клики, ввод текста, горячие клавиши.
//
// Вся платформенная работа — в scripts/gui.ps1 (Win32 P/Invoke). Здесь только
// вызов скрипта и разбор ответа, чтобы остальной код не знал про PowerShell.
//
// Два режима доставки ввода:
//   foreground — SendInput: события идут в системную очередь рядом с настоящими.
//     Работает везде, но двигает реальный курсор и забирает фокус. ВАЖНО: пока
//     фокус у чужого окна, браузер с чатом может подтормаживать — это цена режима.
//   background — PostMessage прямо в окно: курсор не двигается, фокус не
//     воруется. Не все программы принимают (Electron/WPF/Qt рисуют на канвасе).
//     Если у окна нет дочернего контрола Edit/RichEdit — скрипт честно скажет
//     'no_editable_child', и надо переключаться на foreground.

import path from 'node:path';
import { runShell } from './shell.mjs';
import { toolError } from './security.mjs';
import { guiScriptPath } from './assets.mjs';

const WIN = process.platform === 'win32';

// Кэш списка окон на короткое время: один ход модели часто делает несколько
// GUI-действий подряд (focus → click → type), и каждый раз перечислять все
// процессы Windows — лишняя работа. Но кэш ОЧЕНЬ короткий: окна появляются и
// закрываются, а handle устаревает мгновенно. 1.5 с — только чтобы склеить
// соседние вызовы одного шага.
let winCache = { at: 0, list: null };
const WIN_CACHE_MS = 1500;

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function assertWindows() {
  if (!WIN) {
    throw toolError(
      'EPLATFORM',
      'Управление вводом пока только под Windows. На macOS/Linux нужен свой бэкенд (osascript / xdotool).',
    );
  }
}

// Один вызов gui.ps1. Возвращает разобранный JSON.
async function guiCall(args, timeoutMs = 45000) {
  assertWindows();
  const script = guiScriptPath();
  const parts = [`& ${psQuote(script)}`];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    if (value === true) {
      parts.push(`-${key}`);
      continue;
    }
    if (typeof value === 'number') {
      parts.push(`-${key} ${value}`);
      continue;
    }
    parts.push(`-${key} ${psQuote(value)}`);
  }
  const command = parts.join(' ');
  const res = await runShell({ shell: 'powershell', command, timeoutMs });
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();

  // Скрипт печатает JSON одной строкой. Если JSON нет — это ошибка скрипта:
  // показываем stderr, он информативнее пустоты.
  let json = null;
  if (stdout) {
    const line = stdout.split(/\r?\n/).filter(Boolean).pop();
    try {
      json = JSON.parse(line);
    } catch {
      json = null;
    }
  }

  if (!json) {
    const detail = stderr || stdout || res.error || 'скрипт не вернул результат';
    // Разбираем известные коды, чтобы модель получила понятную ошибку, а не
    // «что-то пошло не так».
    if (/window not found/i.test(detail)) throw toolError('EWIN', 'Окно не найдено. Проверь list_windows или уточни process/match.');
    if (/no_editable_child/i.test(detail)) {
      throw toolError(
        'ENOEDIT',
        'У окна нет текстового контрола Edit/RichEdit — background-ввод невозможен. Попробуй mode: "foreground".',
      );
    }
    if (/foreground_denied/i.test(detail)) {
      throw toolError('EFOREGROUND', 'Windows не отдала фокус окну. Закрой перекрывающие окна или проверь, не мешает ли UIPI.');
    }
    if (/unknown key/i.test(detail)) throw toolError('EKEY', detail);
    throw toolError('EGUI', detail.slice(0, 400));
  }

  return json;
}

// ---------- инструменты ----------

export async function guiState({ handle, process, match } = {}) {
  return guiCall({ Action: 'state', Handle: handle, Process: process, Match: match }, 20000);
}

export async function guiFocus({ handle, process, match } = {}) {
  return guiCall({ Action: 'focus', Handle: handle, Process: process, Match: match }, 20000);
}

export async function guiRead({ handle, process, match } = {}) {
  return guiCall({ Action: 'read', Handle: handle, Process: process, Match: match }, 20000);
}

export async function guiSet({ handle, process, match, text } = {}) {
  if (typeof text !== 'string') throw toolError('EARGS', 'Параметр text обязателен');
  return guiCall({ Action: 'set_value', Handle: handle, Process: process, Match: match, Text: text }, 30000);
}

export async function guiType({ handle, process, match, text, mode = 'foreground' } = {}) {
  if (typeof text !== 'string' || !text) throw toolError('EARGS', 'Параметр text обязателен');
  return guiCall(
    { Action: 'type', Handle: handle, Process: process, Match: match, Text: text, Mode: mode },
    30000,
  );
}

export async function guiKey({ handle, process, match, keys, mode = 'foreground' } = {}) {
  if (typeof keys !== 'string' || !keys) throw toolError('EARGS', 'Параметр keys обязателен (например "ctrl+s")');
  return guiCall(
    { Action: 'key', Handle: handle, Process: process, Match: match, Keys: keys, Mode: mode },
    30000,
  );
}

export async function guiClick({ handle, process, match, x, y, button = 'left', count = 1, mode = 'foreground' } = {}) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw toolError('EARGS', 'Нужны координаты x и y (в пикселях экрана)');
  }
  return guiCall(
    { Action: 'click', Handle: handle, Process: process, Match: match, X: Math.round(Number(x)), Y: Math.round(Number(y)), Button: button, Count: Math.max(1, Math.min(3, Number(count) || 1)), Mode: mode },
    30000,
  );
}

export async function guiScroll({ handle, process, match, x = 0, y = 0, delta, mode = 'foreground' } = {}) {
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) throw toolError('EARGS', 'Нужен delta (например -120 вниз, 120 вверх)');
  return guiCall(
    { Action: 'scroll', Handle: handle, Process: process, Match: match, X: Math.round(Number(x) || 0), Y: Math.round(Number(y) || 0), Delta: Math.round(d), Mode: mode },
    30000,
  );
}

export async function guiDrag({ handle, process, match, fromX, fromY, toX, toY, mode = 'foreground' } = {}) {
  const nums = [fromX, fromY, toX, toY].map(Number);
  if (!nums.every(Number.isFinite)) throw toolError('EARGS', 'Нужны fromX, fromY, toX, toY');
  return guiCall(
    { Action: 'drag', Handle: handle, Process: process, Match: match, X: Math.round(nums[0]), Y: Math.round(nums[1]), ToX: Math.round(nums[2]), ToY: Math.round(nums[3]), Mode: mode },
    40000,
  );
}

export async function guiClipboard({ text, set = false } = {}) {
  if (set) {
    if (typeof text !== 'string') throw toolError('EARGS', 'Для записи в буфер нужен text');
    return guiCall({ Action: 'clipboard-set', Text: text }, 20000);
  }
  return guiCall({ Action: 'clipboard-get' }, 20000);
}
