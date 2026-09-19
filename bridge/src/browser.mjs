// Скриншот веб-страницы через уже установленный Chromium (Chrome / Edge) в headless-режиме.
// Своих зависимостей у моста нет и не будет — поэтому берём то, что есть на машине.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './shell.mjs';
import { toolError } from './security.mjs';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function candidates() {
  if (WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      local && path.join(local, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    ].filter(Boolean);
  }
  if (MAC) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

let cached = null;

export function findBrowser() {
  if (process.env.DSBRIDGE_BROWSER && fs.existsSync(process.env.DSBRIDGE_BROWSER)) {
    return process.env.DSBRIDGE_BROWSER;
  }
  if (cached && fs.existsSync(cached)) return cached;
  for (const p of candidates()) {
    if (fs.existsSync(p)) {
      cached = p;
      return p;
    }
  }
  return null;
}

// Типовые пресеты устройств: размер окна + мобильный User-Agent.
const DEVICES = {
  mobile: {
    width: 390,
    height: 844,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  tablet: {
    width: 820,
    height: 1180,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  desktop: { width: 1440, height: 900, ua: null },
};

// Рендерит страницу и сохраняет png. Локальные файлы и http(s) — вызывающий
// решает сам, нужен ли для этого сетевой флаг.
export async function screenshotPage({
  url,
  abs,
  width = 1280,
  height = 900,
  waitMs = 3000,
  timeoutMs = 60000,
  fullPage = false,
  dark = false,
  device = null,
}) {
  const exe = findBrowser();
  if (!exe) {
    throw toolError(
      'ENOBROWSER',
      'Не нашёл Chrome / Edge / Chromium. Установи любой из них или укажи путь в переменной окружения DSBRIDGE_BROWSER',
    );
  }

  const dev = device && DEVICES[String(device).toLowerCase()] ? String(device).toLowerCase() : null;
  const preset = dev ? DEVICES[dev] : null;

  const w = Math.min(Math.max(Number(width) || (preset ? preset.width : 1280), 320), 3840);
  let h = Math.min(Math.max(Number(height) || (preset ? preset.height : 900), 240), 12000);
  // fullPage без CDP: Chrome не сообщает высоту документа через CLI-флаги, поэтому
  // берём заведомо большой кадр. Это приближение «всей страницы», а не точный захват.
  if (fullPage) h = Math.max(h, 6000);
  // virtual-time-budget — это и есть ожидание отрисовки: браузер «прокручивает»
  // время вперёд, поэтому страница успевает выполнить JS и загрузить картинки.
  const wait = Math.min(Math.max(Number(waitMs) || 3000, 0), 30000);
  const outAbs = path.resolve(abs);

  // Свой профиль обязателен: с профилем по умолчанию запущенный Chrome просто
  // открыл бы вкладку в существующем окне и headless-флаг бы проигнорировал.
  const profile = path.join(os.tmpdir(), `dsbridge-headless-${process.pid}-${Date.now()}`);

  // Старый файл НЕ удаляем. Chrome и так перезаписывает цель (проверено), а
  // удаление — лишняя точка отказа: файл может быть занят другой программой,
  // закрыт правами или запрещён политикой, и тогда скриншот падал бы с чужой
  // ошибкой вместо результата.
  //
  // Но совсем без проверки нельзя: если браузер не запишет файл, а старый
  // останется на месте, мы вернём успех со СТАРЫМ скриншотом — то есть молча
  // соврём. Поэтому запоминаем прошлое состояние и убеждаемся, что файл обновлён.
  let before = null;
  try {
    const st = fs.statSync(outAbs);
    before = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    before = null; // файла не было — любое появление считается записью
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    '--user-data-dir=' + profile,
  ];
  if (dark) args.push('--force-dark-mode', '--enable-features=WebContentsForceDark');
  if (preset && preset.ua) args.push('--user-agent=' + preset.ua);
  args.push(`--window-size=${w},${h}`, '--virtual-time-budget=' + wait, '--screenshot=' + outAbs, url);

  let res;
  try {
    res = await runProcess({
      file: exe,
      args,
      timeoutMs: Math.min(Math.max(Number(timeoutMs) || 60000, 5000), 180000),
    });
  } finally {
    // Профиль больше не нужен; если браузер ещё держит файлы — уберёт система.
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // игнорируем
    }
  }

  let st = null;
  try {
    st = fs.statSync(outAbs);
  } catch {
    st = null;
  }

  if (!st) {
    const detail = (res.stderr || res.error || '').trim().slice(0, 400);
    if (res.timedOut) throw toolError('ESHOT', 'Браузер не успел отрисовать страницу за отведённое время');
    throw toolError('ESHOT', 'Браузер не создал файл скриншота' + (detail ? ': ' + detail : ''));
  }

  // Файл есть — но тот ли это файл? Совпадение размера и времени изменения
  // означает, что браузер до цели не добрался, а мы видим прошлый скриншот.
  if (before && st.mtimeMs === before.mtimeMs && st.size === before.size) {
    throw toolError(
      'ESHOT',
      'Браузер не перезаписал ' + path.basename(outAbs) + ' — файл не обновлён (возможно, его держит другая программа)',
    );
  }

  const size = st.size;
  if (!size) {
    throw toolError('ESHOT', 'Скриншот получился пустым');
  }

  return { bytes: size, width: w, height: h, browser: path.basename(exe), device: dev };
}
