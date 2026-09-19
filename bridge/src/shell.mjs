// Запуск команд (PowerShell / cmd / bash) из Node на Windows.
// Учитывает: verbatim-аргументы для cmd, -EncodedCommand для PowerShell,
// UTF-8 вывод, убийство дерева процессов по таймауту.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 64 * 1024; // 64 KB на поток
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 120000;

function cap(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n… обрезано, всего ${text.length} символов`;
}

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

// PowerShell с -EncodedCommand и перенаправленным stderr сериализует ошибки в
// CLIXML: «#< CLIXML <Objs...><S S="Error">текст</S></Objs>», где переводы строк
// закодированы как _x000D__x000A_. В ответе инструмента это мусор — разбираем обратно.
// Отказаться от -EncodedCommand нельзя: именно он держит кириллицу и кавычки.
export function decodeClixml(text) {
  if (!text || !text.includes('#< CLIXML')) return text;
  const parts = [];
  const re = /<S(?:\s[^>]*)?>([\s\S]*?)<\/S>/g;
  let m;
  while ((m = re.exec(text)) !== null) parts.push(m[1]);
  if (!parts.length) return text.replace(/#< CLIXML\s*/g, '').trim();
  return parts
    .join('')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; разворачиваем последним, иначе «&amp;lt;» станет «<» вместо «&lt;».
    .replace(/&amp;/g, '&')
    .trim();
}

// stderr от PowerShell прогоняем через декодер, от остальных оболочек — как есть.
const stderrOf = (text, sh) => (sh === 'powershell' || sh === 'pwsh' ? decodeClixml(text) : text);

export function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // процесс уже мог умереть
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // игнорируем
      }
    }
  }
}

// Общая сборка запуска для синхронного и фонового режимов: иначе правила
// экранирования пришлось бы держать в двух местах и они бы разъехались.
function buildSpawn({ shell, command, cwd, env }) {
  const sh = String(shell || 'powershell').toLowerCase();
  let file;
  let spawnArgs;
  let tmpFile = null;
  const options = { windowsHide: true, cwd };

  // Дополнительные переменные окружения: пригодится, когда инструмент не в PATH
  // (java, gradle, node) — их подставляют вручную на один вызов.
  if (env && typeof env === 'object') {
    const extra = {};
    for (const [k, v] of Object.entries(env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) extra[k] = String(v);
    }
    if (Object.keys(extra).length) options.env = { ...process.env, ...extra };
  }

  if (sh === 'bash' || sh === 'sh') {
    file = process.platform === 'win32' ? 'bash.exe' : '/bin/bash';
    spawnArgs = ['-lc', command];
  } else if (process.platform === 'win32' && (sh === 'cmd' || sh === 'cmd.exe')) {
    file = process.env.COMSPEC || 'cmd.exe';
    if (isAscii(command)) {
      // Verbatim + внешние кавычки: иначе libuv экранирует кавычки как \" и cmd ломается.
      spawnArgs = ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`];
      options.windowsVerbatimArguments = true;
    } else {
      // Не-ASCII: cmd разбирает строку в cp866 ДО chcp, поэтому команду кладём
      // в .cmd-файл в UTF-8 и перечитываем построчно.
      tmpFile = path.join(os.tmpdir(), `dsbridge-${Date.now()}-${Math.random().toString(16).slice(2)}.cmd`);
      fs.writeFileSync(tmpFile, '@echo off\r\nchcp 65001>nul\r\n' + command + '\r\n', 'utf8');
      spawnArgs = ['/d', '/s', '/c', `"${tmpFile}"`];
      options.windowsVerbatimArguments = true;
    }
  } else {
    // PowerShell (Windows) и pwsh; base64 от UTF-16LE снимает все проблемы с кавычками и $.
    const script =
      "$ProgressPreference='SilentlyContinue';" +
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      '$OutputEncoding=[System.Text.Encoding]::UTF8;' +
      command;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    file = sh === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
    spawnArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  }

  return { sh, file, spawnArgs, options, tmpFile };
}

function removeTmp(tmpFile) {
  if (!tmpFile) return;
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // временный файл уберётся системой
  }
}

// Нативный диалог выбора папки Windows. Возвращает путь или null, если отменили.
export async function pickFolder(title = 'Выберите рабочую папку для Дипсик Мост') {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = ' + "'" + String(title).replace(/'/g, "''") + "'",
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
  ].join('; ');
  const res = await runShell({ shell: 'powershell', command: script, timeoutMs: 180000 });
  const out = (res.stdout || '').trim();
  return out || null;
}

export function runShell({ shell = 'powershell', command, cwd, timeoutMs = 30000, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, MIN_TIMEOUT), MAX_TIMEOUT);
    const { sh, file, spawnArgs, options, tmpFile } = buildSpawn({ shell, command, cwd, env });

    let child;
    try {
      child = spawn(file, spawnArgs, options);
    } catch (e) {
      resolve({ error: 'не удалось запустить ' + file + ': ' + e.message, shell: sh });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, ms);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      removeTmp(tmpFile);
      resolve({
        shell: sh,
        exitCode: null,
        stdout: cap(stdout),
        stderr: cap(stderrOf(stderr, sh)),
        error: e.message,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    // Код выхода читаем в 'close', а не 'exit': close гарантирует, что потоки закрыты.
    child.on('close', (code) => {
      clearTimeout(timer);
      removeTmp(tmpFile);
      resolve({
        shell: sh,
        exitCode: code,
        stdout: cap(stdout),
        stderr: cap(stderrOf(stderr, sh)),
        timedOut,
        killed: code === null,
        durationMs: Date.now() - started,
      });
    });
  });
}

// Запуск без оболочки: argv-массив передаётся ядру как есть. Нужен там, где
// аргументы содержат произвольный текст (сообщение коммита) — в шелле их
// пришлось бы экранировать, и любая ошибка экранирования стала бы инъекцией.
export function runProcess({ file, args = [], cwd, timeoutMs = 30000, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, MIN_TIMEOUT), MAX_TIMEOUT);
    const options = { windowsHide: true, cwd };
    if (env && typeof env === 'object') {
      const extra = {};
      for (const [k, v] of Object.entries(env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) extra[k] = String(v);
      }
      if (Object.keys(extra).length) options.env = { ...process.env, ...extra };
    }

    let child;
    try {
      child = spawn(file, args, options);
    } catch (e) {
      resolve({ error: 'не удалось запустить ' + file + ': ' + e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, ms);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: cap(stdout), stderr: cap(stderr), error: e.message, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: cap(stdout),
        stderr: cap(stderr),
        timedOut,
        killed: code === null,
        durationMs: Date.now() - started,
      });
    });
  });
}

// Фоновый запуск: возвращаем управление сразу, вывод копим в кольцевой буфер.
// Нужно для долгих процессов (локальный сервер предпросмотра), которые
// runShell убил бы по таймауту.
export function spawnBackground({ shell = 'powershell', command, cwd, env, bufferLimit = 200_000 }) {
  const { sh, file, spawnArgs, options, tmpFile } = buildSpawn({ shell, command, cwd, env });

  let child;
  try {
    child = spawn(file, spawnArgs, options);
  } catch (e) {
    removeTmp(tmpFile);
    return { error: 'не удалось запустить ' + file + ': ' + e.message };
  }

  const state = {
    pid: child.pid,
    shell: sh,
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    running: true,
    timedOut: false,
    tmpFile,
  };

  const push = (key, text) => {
    state[key] += text;
    if (state[key].length > bufferLimit) {
      state[key] = '… обрезано\n' + state[key].slice(-bufferLimit);
    }
  };

  child.stdout.on('data', (d) => push('stdout', d.toString('utf8')));
  child.stderr.on('data', (d) => push('stderr', d.toString('utf8')));

  child.on('error', (e) => {
    push('stderr', '\n[ошибка запуска] ' + e.message);
    state.running = false;
    state.exitCode = null;
    state.endedAt = Date.now();
    removeTmp(tmpFile);
  });

  child.on('close', (code) => {
    state.running = false;
    state.exitCode = code;
    state.endedAt = Date.now();
    removeTmp(tmpFile);
  });

  return { child, state };
}
