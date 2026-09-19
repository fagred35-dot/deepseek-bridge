import path from 'node:path';
import crypto from 'node:crypto';

// Windows сравнивает пути без учёта регистра, а path.resolve его сохраняет:
// «C:\Users\ВаНя» и «c:\users\ваня» — один и тот же каталог. Приводим к нижнему
// регистру только для сравнения, наружу отдаём исходное написание.
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function inside(target, base) {
  const t = norm(target);
  const b = norm(base);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// Все пути обязаны жить внутри рабочей папки. Выход за её пределы — ошибка.
// extraRoots — необязательный список дополнительных разрешённых каталогов
// (пустой по умолчанию, то есть поведение без него не меняется).
export function resolveInJail(root, rel, extraRoots = []) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, rel ?? '.');
  if (inside(target, rootResolved)) return target;

  for (const extra of extraRoots || []) {
    if (!extra) continue;
    let base;
    try {
      base = path.resolve(String(extra));
    } catch {
      continue;
    }
    if (inside(target, base)) return target;
  }

  const err = new Error('Путь вне рабочей папки');
  err.code = 'EPATHJAIL';
  throw err;
}

// Windows резервирует имена устройств CON, PRN, AUX, NUL, COM1-9, LPT1-9 —
// в любом каталоге и с любым расширением (nul, nul.txt, NUL и т.д.). Node не
// может ни создать, ни переименовать такой файл: fs отдаёт EPERM. Проверено на
// этой машине: префикс \\?\ (Win32 long path) НЕ помогает — доступ запрещён и
// через него. Детектор нужен, чтобы отдать внятную ошибку ERESERVED вместо
// сырого EPERM и попробовать обходной путь через PowerShell.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isReservedName(abs) {
  if (process.platform !== 'win32') return false;
  const base = path.basename(String(abs || ''));
  return WIN_RESERVED.test(base);
}

// Путь с префиксом \\?\ (нужен абсолютный путь с обратными слэшами).
export function toExtendedPath(abs) {
  const win = path.resolve(String(abs)).replace(/\//g, '\\');
  return win.startsWith('\\\\?\\') ? win : '\\\\?\\' + win;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function toolError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
