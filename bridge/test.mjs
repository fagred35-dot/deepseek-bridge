// Smoke-тест моста: поднимает сервер на отдельном порту с изолированной
// рабочей папкой, прогоняет все инструменты и проверки безопасности.
// Запуск: node test.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Изолированные данные: тест НЕ трогает боевой ~/.dsbridge/config.json
const DATA = path.join(__dirname, '..', '.test-data');
const CONFIG = path.join(DATA, 'config.json');
const WORKSPACE = path.join(__dirname, '..', '.test-workspace');
const PORT = 8471;

// Папки снаружи рабочей: одна станет «дополнительным корнем», вторая — соседкой
// с похожим именем, которая НЕ должна открыться (проверка границы по разделителю).
const EXTRA = path.join(__dirname, '..', '.test-extra');
const SIBLING = path.join(__dirname, '..', '.test-extra-other');

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(WORKSPACE, { recursive: true, force: true });
fs.rmSync(EXTRA, { recursive: true, force: true });
fs.rmSync(SIBLING, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(EXTRA, { recursive: true });
fs.mkdirSync(SIBLING, { recursive: true });
fs.writeFileSync(path.join(EXTRA, 'outside.txt'), 'текст снаружи рабочей папки', 'utf8');
fs.writeFileSync(path.join(SIBLING, 'secret.txt'), 'сюда модели нельзя', 'utf8');

const srv = spawn(process.execPath, [path.join(__dirname, 'src', 'server.mjs')], {
  env: {
    ...process.env,
    DSBRIDGE_NO_OPEN: '1',
    DSBRIDGE_DATA: DATA,
    DSBRIDGE_PORT: String(PORT),
    DSBRIDGE_WORKSPACE: WORKSPACE,
    // Тестовая рабочая папка лежит внутри проекта, а сам проект с 19.09.2026 —
    // git-репозиторий. Без потолка `git status` находит родительский репозиторий
    // и отвечает нулевым кодом, хотя тест проверяет «вне репозитория». Потолок
    // запрещает git подниматься выше корня проекта.
    GIT_CEILING_DIRECTORIES: path.resolve(__dirname, '..'),
  },
  stdio: 'ignore',
});

// Локальный сервер для сетевых тестов: без выхода в интернет, зато детерминированно.
// 1x1 PNG в base64 — чтобы проверить скачивание именно бинарника.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const NET_PORT = 8472;
const netServer = http.createServer((req, res) => {
  if (req.url === '/hello.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('привет из сети');
    return;
  }
  if (req.url === '/data.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, source: 'local-test-server' }));
    return;
  }
  if (req.url === '/pixel.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_1PX.length) });
    res.end(PNG_1PX);
    return;
  }
  if (req.url === '/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ received: body, method: req.method }));
    });
    return;
  }
  if (req.url === '/missing') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('нет такого');
    return;
  }
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  res.end('неизвестный путь');
});
netServer.listen(NET_PORT, '127.0.0.1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1300);

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const BASE = `http://127.0.0.1:${cfg.port}`;
const TOKEN = cfg.token;
const AUTH = { 'X-Bridge-Token': TOKEN };

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? ' → ' + extra : ''));
  }
}

async function req(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON — оставим null
  }
  return { status: res.status, json, text };
}
const tool = (name, args) =>
  req('/api/tool', { method: 'POST', headers: AUTH, body: JSON.stringify({ tool: name, args }) }).then((r) => r.json);

try {
  console.log('Мост:', BASE, '| workspace:', cfg.workspaceRoot);

  const health = await req('/api/health');
  check('health отвечает ok', health.json && health.json.ok === true);
  check('health сообщает 40 инструментов', health.json && health.json.tools.length === 40, String(health.json && health.json.tools.length));
  check('health сообщает флаг allowCommands', health.json && health.json.allowCommands === true);

  const noToken = await req('/api/tools');
  check('без токена — 401', noToken.status === 401, String(noToken.status));
  const badToken = await req('/api/tools', { headers: { 'X-Bridge-Token': 'nope' } });
  check('с неверным токеном — 401', badToken.status === 401, String(badToken.status));
  const tools = await req('/api/tools', { headers: AUTH });
  check('список инструментов по токену', tools.json && tools.json.ok === true && tools.json.tools.length === 40);
  check('health сообщает флаг allowNetwork (по умолчанию выключен)', health.json && health.json.allowNetwork === false);

  const ui = await req('/');
  check(
    'UI отдаётся, плейсхолдеры заменены',
    ui.status === 200 && ui.text.includes(TOKEN) && !ui.text.includes('__BRIDGE_TOKEN__') && !ui.text.includes('__WORKSPACE__'),
  );
  check(
    'в UI заменены все плейсхолдеры (порт и версия)',
    !ui.text.includes('__PORT__') && !ui.text.includes('__VERSION__'),
  );

  // Страховка от переделки вёрстки: скрипт страницы ищет элементы по id, и
  // пропавший id ломает интерфейс молча — страница открывается, кнопка не работает.
  const REQUIRED_UI_IDS = [
    'dot', 'status', 'open', 'pick', 'allowCmd', 'allowNet', 'extraRoots', 'addRoot',
    'saveRoots', 'tools', 'instr', 'copyInstr', 'copyToken', 'reveal', 'tokenMasked', 'log',
  ];
  const missingIds = REQUIRED_UI_IDS.filter((id) => !ui.text.includes('id="' + id + '"'));
  check('в UI на месте все элементы, к которым обращается скрипт', missingIds.length === 0, missingIds.join(', '));
  check('в UI есть .path — по нему пишется выбранная папка', ui.text.includes('class="path'));
  check('в инструкции UI есть раздел про память проекта', ui.text.includes('ПАМЯТЬ ПРОЕКТА'));

  const w = await tool('write_file', { path: 'notes.md', content: 'привет мир' });
  check('write_file создаёт файл', w.ok === true && w.result.bytes > 0, JSON.stringify(w));
  const r = await tool('read_file', { path: 'notes.md' });
  check('read_file возвращает содержимое', r.ok === true && r.result.content === 'привет мир', JSON.stringify(r));
  const a = await tool('write_file', { path: 'notes.md', content: '\nвторая', mode: 'append' });
  check('write_file append дописывает', a.ok === true && a.result.mode === 'append');
  const r2 = await tool('read_file', { path: 'notes.md' });
  check('содержимое после append', r2.result.content === 'привет мир\nвторая', JSON.stringify(r2.result.content));

  // --- edit_file ---
  const e1 = await tool('edit_file', { path: 'notes.md', old_string: 'вторая', new_string: 'третья' });
  check('edit_file меняет фрагмент', e1.ok === true && e1.result.replacements === 1, JSON.stringify(e1).slice(0, 220));
  const e1r = await tool('read_file', { path: 'notes.md' });
  check('edit_file — результат в файле', e1r.result.content === 'привет мир\nтретья', JSON.stringify(e1r.result.content));

  const e2 = await tool('edit_file', { path: 'notes.md', old_string: 'нет такого текста', new_string: 'x' });
  check('edit_file без совпадения → ENOMATCH', e2.ok === false && e2.error.code === 'ENOMATCH', JSON.stringify(e2).slice(0, 240));

  const e3 = await tool('edit_file', { path: 'notes.md', old_string: 'т', new_string: 'Т' });
  check('edit_file на неоднозначный фрагмент → EAMBIGUOUS', e3.ok === false && e3.error.code === 'EAMBIGUOUS', JSON.stringify(e3).slice(0, 280));

  // в «привет мир\nтретья» три буквы «т»: одна в «привет», две в «третья»
  const e4 = await tool('edit_file', { path: 'notes.md', old_string: 'т', new_string: 'Т', replace_all: true });
  check('edit_file replace_all заменяет все', e4.ok === true && e4.result.replacements === 3, JSON.stringify(e4).slice(0, 240));

  const e5 = await tool('edit_file', { path: 'notes.md', old_string: ' мир', new_string: '' });
  check('edit_file с пустым new_string удаляет фрагмент', e5.ok === true, JSON.stringify(e5).slice(0, 240));
  const e5r = await tool('read_file', { path: 'notes.md' });
  check('edit_file — удаление сработало', e5r.result.content === 'привеТ\nТреТья', JSON.stringify(e5r.result.content));

  const e6 = await tool('edit_file', { path: 'notes.md', old_string: '', new_string: 'x' });
  check('edit_file с пустым old_string → EARGS', e6.ok === false && e6.error.code === 'EARGS', JSON.stringify(e6).slice(0, 240));

  const e7 = await tool('edit_file', { path: 'notes.md', old_string: 'привеТ', new_string: 'привеТ' });
  check('edit_file с одинаковыми строками → EARGS', e7.ok === false && e7.error.code === 'EARGS', JSON.stringify(e7).slice(0, 240));

  const e8 = await tool('edit_file', { path: 'нет-такого.md', old_string: 'a', new_string: 'b' });
  check('edit_file на отсутствующий файл → ENOENT', e8.ok === false && e8.error.code === 'ENOENT', JSON.stringify(e8).slice(0, 240));

  // --- мягкое совпадение (терпимость к отступам) ---
  //
  // Модель часто присылает блок без отступов или с чужими отступами. Раньше это
  // давало ENOMATCH, лишний round-trip и риск поймать лимит частоты. Теперь
  // правка применяется, а в ответе стоит fuzzy: true.
  const indented = 'function a() {\n  const x = 1;\n  return x;\n}\n';
  await tool('write_file', { path: 'fuzzy.js', content: indented });

  const f0 = await tool('edit_file', { path: 'fuzzy.js', old_string: '  const x = 1;', new_string: '  const x = 9;' });
  check('точное совпадение не помечается как мягкое', f0.ok === true && f0.result.fuzzy === false, JSON.stringify(f0).slice(0, 240));

  const f1 = await tool('edit_file', {
    path: 'fuzzy.js',
    old_string: 'const x = 9;\nreturn x;',
    new_string: 'const x = 2;\nreturn x + 1;',
  });
  check('правка без отступов применяется', f1.ok === true && f1.result.fuzzy === true, JSON.stringify(f1).slice(0, 260));
  check('сдвиг отступа посчитан', f1.result && f1.result.indentShift === 2, JSON.stringify(f1.result));
  const f1r = await tool('read_file', { path: 'fuzzy.js' });
  check(
    'отступ в файле сохранён, а не потерян',
    f1r.result.content === 'function a() {\n  const x = 2;\n  return x + 1;\n}\n',
    JSON.stringify(f1r.result.content),
  );

  // Хвостовые пробелы и пустая строка внутри фрагмента тоже не должны мешать.
  await tool('write_file', { path: 'fuzzy2.txt', content: 'один   \nдва\n\nтри\n' });
  const f2 = await tool('edit_file', { path: 'fuzzy2.txt', old_string: 'один\nдва', new_string: 'ОДИН\nДВА' });
  check('хвостовые пробелы не мешают', f2.ok === true && f2.result.fuzzy === true, JSON.stringify(f2).slice(0, 240));
  const f2r = await tool('read_file', { path: 'fuzzy2.txt' });
  check('замена без потери остальных строк', f2r.result.content === 'ОДИН\nДВА\n\nтри\n', JSON.stringify(f2r.result.content));

  // Файл с CRLF, а модель прислала \n — раньше это был гарантированный ENOMATCH.
  await tool('write_file', { path: 'crlf.txt', content: 'первая\r\nвторая\r\n' });
  const f3 = await tool('edit_file', { path: 'crlf.txt', old_string: 'первая\nвторая', new_string: 'первая\nВТОРАЯ' });
  check('перевод строк CRLF не мешает', f3.ok === true && f3.result.fuzzy === true, JSON.stringify(f3).slice(0, 240));
  const f3r = await tool('read_file', { path: 'crlf.txt' });
  check('CRLF-файл правлен по существу', String(f3r.result.content).includes('ВТОРАЯ'), JSON.stringify(f3r.result.content));

  // Мягкий поиск не должен терять защиту от неоднозначности: иначе он заменит
  // не то место, и это хуже, чем честный отказ.
  await tool('write_file', { path: 'amb.txt', content: 'a\n  a\n' });
  const f4 = await tool('edit_file', { path: 'amb.txt', old_string: 'a ', new_string: 'b' });
  check('мягкое совпадение тоже ловит неоднозначность', f4.ok === false && f4.error.code === 'EAMBIGUOUS', JSON.stringify(f4).slice(0, 260));

  const f5 = await tool('edit_file', { path: 'amb.txt', old_string: 'a ', new_string: 'b', replace_all: true });
  check('мягкое совпадение работает с replace_all', f5.ok === true && f5.result.replacements === 2, JSON.stringify(f5).slice(0, 240));

  const f6 = await tool('edit_file', { path: 'amb.txt', old_string: 'совсем другой текст', new_string: 'x' });
  check('мягкое совпадение не выдумывает совпадений → ENOMATCH', f6.ok === false && f6.error.code === 'ENOMATCH', JSON.stringify(f6).slice(0, 240));

  const f7 = await tool('edit_many', {
    path: 'fuzzy.js',
    edits: [{ old: 'const x = 2;\nreturn x + 1;', new: 'const x = 5;\nreturn x;' }],
  });
  check('edit_many тоже терпит отступы', f7.ok === true && f7.result.results[0].fuzzy === true, JSON.stringify(f7).slice(0, 320));
  const f7r = await tool('read_file', { path: 'fuzzy.js' });
  check(
    'edit_many с мягким совпадением сохранил отступы',
    f7r.result.content === 'function a() {\n  const x = 5;\n  return x;\n}\n',
    JSON.stringify(f7r.result.content),
  );

  // --- edit_many ---

  // Готовим чистый файл: три отдельные строки, чтобы правки шли по разным местам.
  await tool('write_file', { path: 'many.txt', content: 'alpha = 1\nbeta = 2\ngamma = 3\n' });

  const m1 = await tool('edit_many', {
    path: 'many.txt',
    edits: [
      { old: 'alpha = 1', new: 'alpha = 10' },
      { old: 'gamma = 3', new: 'gamma = 30' },
    ],
  });
  check('edit_many применяет все правки', m1.ok === true && m1.result.applied === 2 && m1.result.failed === 0, JSON.stringify(m1).slice(0, 320));
  const m1r = await tool('read_file', { path: 'many.txt' });
  check('edit_many — результат в файле', m1r.result.content === 'alpha = 10\nbeta = 2\ngamma = 30\n', JSON.stringify(m1r.result.content));

  // Последовательность: вторая правка ищет то, что появилось после первой.
  await tool('write_file', { path: 'seq.txt', content: 'x\n' });
  const m2 = await tool('edit_many', {
    path: 'seq.txt',
    edits: [
      { old: 'x', new: 'y' },
      { old: 'y', new: 'z' },
    ],
  });
  check('edit_many применяет правки последовательно', m2.ok === true && m2.result.applied === 2, JSON.stringify(m2).slice(0, 320));
  const m2r = await tool('read_file', { path: 'seq.txt' });
  check('edit_many — последовательный результат', m2r.result.content === 'z\n', JSON.stringify(m2r.result.content));

  // Атомарность: одна правка не находится — файл не меняется вообще.
  await tool('write_file', { path: 'atomic.txt', content: 'aaa\nbbb\n' });
  const m3 = await tool('edit_many', {
    path: 'atomic.txt',
    edits: [
      { old: 'aaa', new: 'AAA' },
      { old: 'нет такого', new: 'x' },
    ],
  });
  check('edit_many атомарно падает на ENOMATCH', m3.ok === false && m3.error.code === 'ENOMATCH', JSON.stringify(m3).slice(0, 320));
  const m3r = await tool('read_file', { path: 'atomic.txt' });
  check('edit_many при атомарном провале файл не тронут', m3r.result.content === 'aaa\nbbb\n', JSON.stringify(m3r.result.content));

  // Атомарность отключена — применяются удачные правки, неудачные в failed.
  const m4 = await tool('edit_many', {
    path: 'atomic.txt',
    atomic: false,
    edits: [
      { old: 'aaa', new: 'AAA' },
      { old: 'нет такого', new: 'x' },
      { old: 'bbb', new: 'BBB' },
    ],
  });
  check('edit_many atomic:false применяет удачные', m4.ok === true && m4.result.applied === 2 && m4.result.failed === 1, JSON.stringify(m4).slice(0, 400));
  const m4r = await tool('read_file', { path: 'atomic.txt' });
  check('edit_many atomic:false — частичный результат', m4r.result.content === 'AAA\nBBB\n', JSON.stringify(m4r.result.content));

  // Неоднозначная правка: без replace_all атомарно падает.
  await tool('write_file', { path: 'amb.txt', content: 'ttt\n' });
  const m5 = await tool('edit_many', {
    path: 'amb.txt',
    edits: [{ old: 't', new: 'T' }],
  });
  check('edit_many неоднозначность → EAMBIGUOUS', m5.ok === false && m5.error.code === 'EAMBIGUOUS', JSON.stringify(m5).slice(0, 320));

  const m6 = await tool('edit_many', {
    path: 'amb.txt',
    edits: [{ old: 't', new: 'T', replace_all: true }],
  });
  check('edit_many replace_all внутри пакета', m6.ok === true && m6.result.applied === 1, JSON.stringify(m6).slice(0, 320));
  const m6r = await tool('read_file', { path: 'amb.txt' });
  check('edit_many replace_all — результат', m6r.result.content === 'TTT\n', JSON.stringify(m6r.result.content));

  // Валидация аргументов.
  const m7 = await tool('edit_many', { path: 'many.txt', edits: [] });
  check('edit_many с пустым edits → EARGS', m7.ok === false && m7.error.code === 'EARGS', JSON.stringify(m7).slice(0, 240));

  const m8 = await tool('edit_many', { path: 'many.txt', edits: [{ old: '', new: 'x' }] });
  check('edit_many с пустой old → EARGS', m8.ok === false && m8.error.code === 'EARGS', JSON.stringify(m8).slice(0, 240));

  const m9 = await tool('edit_many', { path: 'many.txt', edits: [{ old: 'q', new: 'q' }] });
  check('edit_many с old===new → EARGS', m9.ok === false && m9.error.code === 'EARGS', JSON.stringify(m9).slice(0, 240));

  const m10 = await tool('edit_many', { path: 'many.txt', edits: ['строка вместо объекта'] });
  check('edit_many с элементом не-объектом → EARGS', m10.ok === false && m10.error.code === 'EARGS', JSON.stringify(m10).slice(0, 240));

  const m11 = await tool('edit_many', { path: 'нет-такого.txt', edits: [{ old: 'a', new: 'b' }] });
  check('edit_many на отсутствующий файл → ENOENT', m11.ok === false && m11.error.code === 'ENOENT', JSON.stringify(m11).slice(0, 240));

  // Алиасы ключей: модель по привычке от edit_file пишет { old_string, new_string }.
  // Раньше это давало невнятное «old не может быть пустой» — теперь принимаем оба набора.
  const m12 = await tool('edit_many', {
    path: 'many.txt',
    edits: [{ old_string: 'beta = 2', new_string: 'beta = 20' }],
  });
  check('edit_many принимает old_string/new_string', m12.ok === true && m12.result.applied === 1, JSON.stringify(m12).slice(0, 320));
  const m12r = await tool('read_file', { path: 'many.txt' });
  check('edit_many с алиасами — результат в файле', m12r.result.content === 'alpha = 10\nbeta = 20\ngamma = 30\n', JSON.stringify(m12r.result.content));

  const m13 = await tool('edit_many', { path: 'many.txt', edits: [{ old: '', old_string: '', new: 'x' }] });
  check('edit_many с пустыми old и old_string → EARGS', m13.ok === false && m13.error.code === 'EARGS', JSON.stringify(m13).slice(0, 240));

  const m14 = await tool('edit_many', { path: 'many.txt', edits: [{ replace_all: true }] });
  check('edit_many без old и old_string → EARGS с подсказкой', m14.ok === false && m14.error.code === 'EARGS' && /old_string/.test(m14.error.message), JSON.stringify(m14).slice(0, 240));

  const ls = await tool('list_dir', { path: '.' });
  check('list_dir видит notes.md', ls.ok === true && ls.result.items.some((i) => i.name === 'notes.md'));

  const se = await tool('search', { query: 'привет' });
  check('search находит по содержимому', se.ok === true && se.result.matches.includes('notes.md'), JSON.stringify(se.result));

  const mv = await tool('move', { from: 'notes.md', to: 'docs/notes.md' });
  check('move перемещает файл', mv.ok === true && mv.result.to === 'docs/notes.md', JSON.stringify(mv));
  const st = await tool('stat', { path: 'docs/notes.md' });
  check('stat показывает файл', st.ok === true && st.result.type === 'file');

  const del = await tool('delete', { path: 'docs/notes.md' });
  check('delete уносит в .trash', del.ok === true && del.result.trashed.startsWith('.trash'), JSON.stringify(del));
  const after = await tool('stat', { path: 'docs/notes.md' });
  check('после delete файла нет', after.ok === false && after.error.code === 'ENOENT', JSON.stringify(after));

  const jail = await tool('read_file', { path: '../../../../Windows/win.ini' });
  check('path jail блокирует выход наружу', jail.ok === false && jail.error.code === 'EPATHJAIL', JSON.stringify(jail));
  const jail2 = await tool('read_file', { path: 'C:/Windows/win.ini' });
  check('path jail блокирует абсолютный путь', jail2.ok === false && jail2.error.code === 'EPATHJAIL', JSON.stringify(jail2));

  const root = await tool('delete', { path: '.' });
  check('нельзя удалить корень рабочей папки', root.ok === false && root.error.code === 'EROOT', JSON.stringify(root));

  const unknown = await tool('nope', {});
  check('неизвестный инструмент → ENOTOOL', unknown.ok === false && unknown.error.code === 'ENOTOOL');

  // --- run_command ---
  const ps = await tool('run_command', { shell: 'powershell', command: 'Write-Output "проверка юникода"' });
  check('run_command powershell + UTF-8', ps.ok === true && ps.result.exitCode === 0 && ps.result.stdout.includes('проверка юникода'), JSON.stringify(ps).slice(0, 180));

  const cmd2 = await tool('run_command', { shell: 'cmd', command: 'echo первая & echo вторая' });
  check('run_command cmd + кириллица в команде', cmd2.ok === true && cmd2.result.stdout.includes('первая') && cmd2.result.stdout.includes('вторая'), JSON.stringify(cmd2).slice(0, 180));

  const code3 = await tool('run_command', { shell: 'cmd', command: 'exit /b 3' });
  check('run_command отдаёт код выхода 3', code3.ok === true && code3.result.exitCode === 3, JSON.stringify(code3).slice(0, 180));

  const to = await tool('run_command', { shell: 'powershell', command: 'Start-Sleep -Seconds 5', timeoutMs: 1000 });
  check('run_command убивает по таймауту', to.ok === true && to.result.timedOut === true, JSON.stringify(to).slice(0, 180));

  const jailCmd = await tool('run_command', { shell: 'cmd', command: 'echo hi', cwd: '../../..' });
  check('run_command уважает path jail', jailCmd.ok === false && jailCmd.error.code === 'EPATHJAIL');

  const envPs = await tool('run_command', {
    shell: 'powershell',
    command: 'Write-Output $env:DSBRIDGE_TEST_VAR',
    env: { DSBRIDGE_TEST_VAR: 'работает' },
  });
  check(
    'run_command передаёт env в PowerShell',
    envPs.ok === true && envPs.result.stdout.includes('работает') && envPs.result.envKeys.includes('DSBRIDGE_TEST_VAR'),
    JSON.stringify(envPs).slice(0, 240),
  );

  const envCmd = await tool('run_command', { shell: 'cmd', command: 'echo %DSBRIDGE_TEST_VAR%', env: { DSBRIDGE_TEST_VAR: 'ok-env' } });
  check('run_command передаёт env в cmd', envCmd.ok === true && envCmd.result.stdout.includes('ok-env'), JSON.stringify(envCmd).slice(0, 240));

  const psErr = await tool('run_command', { shell: 'powershell', command: 'этой-команды-нет-12345' });
  check(
    'stderr PowerShell — читаемый текст, а не CLIXML',
    psErr.ok === true && psErr.result.exitCode !== 0 && psErr.result.stderr.length > 0 && !psErr.result.stderr.includes('CLIXML') && !psErr.result.stderr.includes('_x000D_'),
    JSON.stringify(psErr).slice(0, 320),
  );

  const off = await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ allowCommands: false }) });
  check('настройка allowCommands=false применяется', !!off.json && off.json.allowCommands === false);
  const blocked = await tool('run_command', { shell: 'cmd', command: 'echo hi' });
  check('run_command выключен → EDISABLED', blocked.ok === false && blocked.error.code === 'EDISABLED', JSON.stringify(blocked).slice(0, 180));
  await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ allowCommands: true }) });

  // --- tree / read_lines / grep / hash ---
  await tool('write_file', { path: 'src/app.js', content: 'const x = 1;\nconsole.log(x);\n' });
  await tool('write_file', { path: 'src/util/helper.js', content: 'export const hi = 1;\n' });

  const tr = await tool('tree', { path: '.', depth: 3 });
  check(
    'tree показывает вложенные файлы',
    tr.ok === true && tr.result.tree.includes('helper.js') && tr.result.dirs >= 1,
    JSON.stringify(tr).slice(0, 220),
  );

  const rl = await tool('read_lines', { path: 'src/app.js', start: 1, count: 1 });
  check('read_lines читает диапазон', rl.ok === true && rl.result.lines[0] === 'const x = 1;', JSON.stringify(rl).slice(0, 220));

  const tl = await tool('read_lines', { path: 'src/app.js', tail: 1 });
  check(
    'read_lines tail отдаёт хвост',
    tl.ok === true && tl.result.lines[tl.result.lines.length - 1].includes('console.log'),
    JSON.stringify(tl).slice(0, 220),
  );

  const gr = await tool('grep', { pattern: 'console\\.log', path: '.' });
  check(
    'grep находит по регулярке с номерами строк',
    gr.ok === true && gr.result.matches.some((m) => m.file.includes('app.js') && m.line === 2),
    JSON.stringify(gr).slice(0, 260),
  );

  const grI = await tool('grep', { pattern: 'CONSOLE', path: '.' });
  check('grep без ignoreCase не находит', grI.ok === true && grI.result.matches.length === 0, JSON.stringify(grI).slice(0, 200));
  const grIc = await tool('grep', { pattern: 'CONSOLE', path: '.', ignoreCase: true });
  check('grep ignoreCase находит', grIc.ok === true && grIc.result.matches.length > 0, JSON.stringify(grIc).slice(0, 200));

  const badRe = await tool('grep', { pattern: '([', path: '.' });
  check('grep с плохой регуляркой → EARGS', badRe.ok === false && badRe.error.code === 'EARGS', JSON.stringify(badRe).slice(0, 200));

  // grep по конкретному файлу: walk() тут не работает, путь должен приниматься как файл
  const grFile = await tool('grep', { pattern: 'console', path: 'src/app.js' });
  check(
    'grep по одному файлу находит совпадение',
    grFile.ok === true && grFile.result.matches.length === 1 && grFile.result.matches[0].file === 'src/app.js',
    JSON.stringify(grFile).slice(0, 260),
  );

  const grGlob = await tool('grep', { pattern: 'console', path: '.', glob: '*.js' });
  check(
    'grep glob фильтрует по расширению',
    grGlob.ok === true && grGlob.result.matches.length > 0 && grGlob.result.matches.every((m) => m.file.endsWith('.js')),
    JSON.stringify(grGlob).slice(0, 260),
  );

  const grGlobNo = await tool('grep', { pattern: 'console', path: '.', glob: '*.md' });
  check('grep glob отсекает неподходящие файлы', grGlobNo.ok === true && grGlobNo.result.matches.length === 0, JSON.stringify(grGlobNo).slice(0, 220));

  const grCtx = await tool('grep', { pattern: 'console\\.log', path: 'src/app.js', context: 1 });
  check(
    'grep context отдаёт соседние строки',
    grCtx.ok === true &&
      grCtx.result.matches[0].before.length === 1 &&
      grCtx.result.matches[0].before[0].text.includes('const x') &&
      grCtx.result.matches[0].after.length === 0,
    JSON.stringify(grCtx).slice(0, 320),
  );

  const h = await tool('hash', { path: 'src/app.js', algo: 'sha256' });
  check('hash sha256 даёт 64 hex', h.ok === true && /^[0-9a-f]{64}$/.test(h.result.hash), JSON.stringify(h).slice(0, 220));
  const h2 = await tool('hash', { path: 'src/app.js', algo: 'md5' });
  check('hash md5 даёт 32 hex', h2.ok === true && /^[0-9a-f]{32}$/.test(h2.result.hash), JSON.stringify(h2).slice(0, 220));
  const h3 = await tool('hash', { path: 'src/app.js', algo: 'crc32' });
  check('hash с неподдержанным алгоритмом → EARGS', h3.ok === false && h3.error.code === 'EARGS', JSON.stringify(h3).slice(0, 200));

  const si = await tool('sysinfo', {});
  check(
    'sysinfo отдаёт ОС, память и диск',
    si.ok === true && si.result.platform === process.platform && si.result.memoryTotalMB > 0 && si.result.diskTotalGB > 0,
    JSON.stringify(si).slice(0, 260),
  );

  // --- zip / unzip ---
  const z = await tool('zip', { path: 'src', dest: 'out/src.zip' });
  check('zip упаковывает папку', z.ok === true && z.result.bytes > 0, JSON.stringify(z).slice(0, 260));

  const uz = await tool('unzip', { path: 'out/src.zip', dest: 'unpacked' });
  check('unzip распаковывает', uz.ok === true, JSON.stringify(uz).slice(0, 220));
  const back = await tool('read_file', { path: 'unpacked/app.js' });
  check('после unzip файл на месте', back.ok === true && back.result.content.includes('console.log'), JSON.stringify(back).slice(0, 220));

  const zipJail = await tool('zip', { path: 'src', dest: '../../escape.zip' });
  check('zip уважает path jail', zipJail.ok === false && zipJail.error.code === 'EPATHJAIL', JSON.stringify(zipJail).slice(0, 220));

  // --- write_binary ---
  const pngB64 = PNG_1PX.toString('base64');
  const pngSha = crypto.createHash('sha256').update(PNG_1PX).digest('hex');

  const wb = await tool('write_binary', { path: 'assets/pixel.png', base64: pngB64 });
  check('write_binary пишет файл из base64', wb.ok === true && wb.result.bytes === PNG_1PX.length, JSON.stringify(wb).slice(0, 260));
  const wbHash = await tool('hash', { path: 'assets/pixel.png', algo: 'sha256' });
  check('write_binary — байты совпадают с исходником', wbHash.ok === true && wbHash.result.hash === pngSha, JSON.stringify(wbHash).slice(0, 260));

  const wbData = await tool('write_binary', { path: 'assets/from-dataurl.png', base64: 'data:image/png;base64,' + pngB64 });
  check('write_binary принимает data:URL', wbData.ok === true && wbData.result.detectedType === 'image/png', JSON.stringify(wbData).slice(0, 260));

  const wbBad = await tool('write_binary', { path: 'assets/bad.bin', base64: 'это не base64!!!' });
  check('write_binary отвергает не-base64', wbBad.ok === false && wbBad.error.code === 'EARGS', JSON.stringify(wbBad).slice(0, 260));

  const wbEmpty = await tool('write_binary', { path: 'assets/empty.bin', base64: '' });
  check('write_binary с пустым base64 → EARGS', wbEmpty.ok === false && wbEmpty.error.code === 'EARGS', JSON.stringify(wbEmpty).slice(0, 240));

  const wbJail = await tool('write_binary', { path: '../../evil.png', base64: pngB64 });
  check('write_binary уважает path jail', wbJail.ok === false && wbJail.error.code === 'EPATHJAIL', JSON.stringify(wbJail).slice(0, 240));

  // --- git ---
  const gv = await tool('git', { subcommand: 'version' });
  check('git запускается без шелла (argv-массив)', gv.ok === true && gv.result.exitCode === 0 && /git version/.test(gv.result.stdout), JSON.stringify(gv).slice(0, 260));

  const gStatus0 = await tool('git', { subcommand: 'status' });
  check('git status вне репозитория не падает, а сообщает код', gStatus0.ok === true && gStatus0.result.exitCode !== 0, JSON.stringify(gStatus0).slice(0, 260));

  const gInit = await tool('git', { subcommand: 'init' });
  check('git init работает при включённых командах', gInit.ok === true && gInit.result.exitCode === 0, JSON.stringify(gInit).slice(0, 260));

  // Локальная идентичность — иначе commit зависит от глобального git config машины.
  await tool('git', { subcommand: 'config', args: ['user.name', 'Дипсик Мост Тест'] });
  await tool('git', { subcommand: 'config', args: ['user.email', 'test@example.invalid'] });

  await tool('write_file', { path: 'tracked.txt', content: 'версия 1\n' });
  const gAdd = await tool('git', { subcommand: 'add', args: ['tracked.txt'] });
  check('git add принимает argv-массив', gAdd.ok === true && gAdd.result.exitCode === 0, JSON.stringify(gAdd).slice(0, 260));

  const gCommit = await tool('git', { subcommand: 'commit', args: ['-m', 'первый коммит с кириллицей и "кавычками"'] });
  check('git commit с кириллицей и кавычками в сообщении', gCommit.ok === true && gCommit.result.exitCode === 0, JSON.stringify(gCommit).slice(0, 320));

  const gLog = await tool('git', { subcommand: 'log', args: ['--oneline'] });
  check('git log показывает коммит', gLog.ok === true && gLog.result.stdout.includes('первый коммит'), JSON.stringify(gLog).slice(0, 280));

  const gBlocked = await tool('git', { subcommand: 'status', args: ['--exec-path', '/tmp'] });
  check('git блокирует опасный аргумент', gBlocked.ok === false && gBlocked.error.code === 'EARGS', JSON.stringify(gBlocked).slice(0, 260));

  const gUnknown = await tool('git', { subcommand: 'pushd' });
  check('git с неизвестной подкомандой → EARGS', gUnknown.ok === false && gUnknown.error.code === 'EARGS', JSON.stringify(gUnknown).slice(0, 260));

  await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ allowCommands: false }) });
  const gReadOk = await tool('git', { subcommand: 'log', args: ['--oneline'] });
  check('git log работает и при выключенных командах', gReadOk.ok === true && gReadOk.result.exitCode === 0, JSON.stringify(gReadOk).slice(0, 260));
  const gWriteBlocked = await tool('git', { subcommand: 'commit', args: ['-m', 'нет'] });
  check('git commit при выключенных командах → EDISABLED', gWriteBlocked.ok === false && gWriteBlocked.error.code === 'EDISABLED', JSON.stringify(gWriteBlocked).slice(0, 260));
  await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ allowCommands: true }) });

  // --- фоновые процессы ---
  const badProc = await tool('start_process', { command: 'этой-команды-нет-12345', shell: 'powershell', name: 'bad' });
  check('start_process сообщает о мгновенной смерти', badProc.ok === true && badProc.result.running === false, JSON.stringify(badProc).slice(0, 320));

  const bg = await tool('start_process', { command: 'Start-Sleep -Seconds 60', shell: 'powershell', name: 'sleeper' });
  check('start_process запускает и отдаёт pid', bg.ok === true && bg.result.running === true && bg.result.pid > 0, JSON.stringify(bg).slice(0, 320));

  const lp = await tool('list_processes', {});
  check('list_processes видит фоновый процесс', lp.ok === true && lp.result.processes.some((p) => p.name === 'sleeper' && p.running), JSON.stringify(lp).slice(0, 320));

  const kp = await tool('kill_process', { name: 'sleeper' });
  check('kill_process останавливает по имени', kp.ok === true && kp.result.stopped === true, JSON.stringify(kp).slice(0, 320));

  const lpAfter = await tool('list_processes', {});
  check('после kill процесса в списке нет', lpAfter.ok === true && !lpAfter.result.processes.some((p) => p.name === 'sleeper'), JSON.stringify(lpAfter).slice(0, 320));

  const kpMissing = await tool('kill_process', { pid: 999999 });
  check('kill_process с неизвестным pid → ENOPROC', kpMissing.ok === false && kpMissing.error.code === 'ENOPROC', JSON.stringify(kpMissing).slice(0, 260));

  // --- сеть: сначала убеждаемся, что флаг выключен ---
  const NET = `http://127.0.0.1:${NET_PORT}`;
  const netOffGet = await tool('http_get', { url: NET + '/hello.txt' });
  check('http_get при выключенном allowNetwork → EDISABLED', netOffGet.ok === false && netOffGet.error.code === 'EDISABLED', JSON.stringify(netOffGet).slice(0, 260));
  const netOffDl = await tool('download', { url: NET + '/pixel.png', path: 'net/off.png' });
  check('download при выключенном allowNetwork → EDISABLED', netOffDl.ok === false && netOffDl.error.code === 'EDISABLED', JSON.stringify(netOffDl).slice(0, 260));
  // Скриншот по адресу — тоже сетевой доступ, и проверять это надо до включения флага.
  const netOffShot = await tool('screenshot', { url: NET + '/hello.txt', path: 'screenshots/remote-off.png' });
  check('screenshot адреса при выключенном allowNetwork → EDISABLED', netOffShot.ok === false && netOffShot.error.code === 'EDISABLED', JSON.stringify(netOffShot).slice(0, 280));

  const netOn = await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ allowNetwork: true }) });
  check('настройка allowNetwork включается', !!netOn.json && netOn.json.allowNetwork === true, JSON.stringify(netOn.json));

  const hg = await tool('http_get', { url: NET + '/hello.txt' });
  check('http_get отдаёт текст', hg.ok === true && hg.result.status === 200 && hg.result.body === 'привет из сети', JSON.stringify(hg).slice(0, 280));

  const hj = await tool('http_get', { url: NET + '/data.json' });
  check('http_get отдаёт JSON как текст', hj.ok === true && JSON.parse(hj.result.body).source === 'local-test-server', JSON.stringify(hj).slice(0, 280));

  const h404 = await tool('http_get', { url: NET + '/missing' });
  check('http_get на 404 отдаёт статус, а не ошибку', h404.ok === true && h404.result.status === 404 && h404.result.ok === false, JSON.stringify(h404).slice(0, 280));

  const hp = await tool('http_post', { url: NET + '/echo', body: { hello: 'мир' } });
  check('http_post отправляет тело и получает эхо', hp.ok === true && JSON.parse(hp.result.body).received === '{"hello":"мир"}', JSON.stringify(hp).slice(0, 320));

  const hbin = await tool('http_get', { url: NET + '/pixel.png' });
  check('http_get не тащит бинарник в чат', hbin.ok === true && hbin.result.binary === true && !hbin.result.body, JSON.stringify(hbin).slice(0, 280));

  const dl = await tool('download', { url: NET + '/pixel.png', path: 'net/pixel.png' });
  check('download сохраняет бинарник в рабочую папку', dl.ok === true && dl.result.bytes === PNG_1PX.length, JSON.stringify(dl).slice(0, 280));
  const dlHash = await tool('hash', { path: 'net/pixel.png', algo: 'sha256' });
  check('download — файл побайтово совпадает', dlHash.ok === true && dlHash.result.hash === pngSha, JSON.stringify(dlHash).slice(0, 280));

  const dlName = await tool('download', { url: NET + '/hello.txt' });
  check('download сам выводит имя файла из URL', dlName.ok === true && dlName.result.path === 'hello.txt', JSON.stringify(dlName).slice(0, 260));

  const dl404 = await tool('download', { url: NET + '/missing', path: 'net/no.txt' });
  check('download на 404 → EHTTP', dl404.ok === false && dl404.error.code === 'EHTTP', JSON.stringify(dl404).slice(0, 260));
  const noStub = await tool('stat', { path: 'net/no.txt' });
  check('после неудачного download мусор не остался', noStub.ok === false && noStub.error.code === 'ENOENT', JSON.stringify(noStub).slice(0, 260));

  const badUrl = await tool('http_get', { url: 'ftp://example.com/x' });
  check('http_get с не-http схемой → EBADURL', badUrl.ok === false && badUrl.error.code === 'EBADURL', JSON.stringify(badUrl).slice(0, 260));

  const dlJail = await tool('download', { url: NET + '/hello.txt', path: '../../escape.txt' });
  check('download уважает path jail', dlJail.ok === false && dlJail.error.code === 'EPATHJAIL', JSON.stringify(dlJail).slice(0, 260));

  const pageRemote = await tool('screenshot', { url: NET + '/hello.txt', path: 'screenshots/remote.png', width: 640, height: 320 });
  check(
    'screenshot адреса работает при allowNetwork',
    pageRemote.ok === true && pageRemote.result.mode === 'page-remote' && pageRemote.result.bytes > 500,
    JSON.stringify(pageRemote).slice(0, 320),
  );

  // --- list_windows / screenshot ---
  const lw = await tool('list_windows', {});
  check('list_windows отдаёт список', lw.ok === true && Array.isArray(lw.result.windows), JSON.stringify(lw).slice(0, 260));

  const shot = await tool('screenshot', { path: 'screenshots/full.png' });
  check('screenshot всего экрана пишет png', shot.ok === true && shot.result.bytes > 1000, JSON.stringify(shot).slice(0, 260));

  const shotBad = await tool('screenshot', { window: 'заведомо-нет-такого-окна-12345', path: 'screenshots/no.png' });
  check('screenshot несуществующего окна → ESHOT', shotBad.ok === false && shotBad.error.code === 'ESHOT', JSON.stringify(shotBad).slice(0, 260));

  // --- скриншот веб-страницы ---
  await tool('write_file', {
    path: 'site/index.html',
    content:
      '<!doctype html><meta charset="utf-8">' +
      '<style>body{font:40px sans-serif;background:#101020;color:#eee;padding:40px}b{color:#e3b53a}</style>' +
      '<h1>Проверка <b>кириллицы</b></h1>',
  });

  // Локальную страницу рендерим без сети — это и есть «увидеть собранный html».
  const pageShot = await tool('screenshot', { url: 'site/index.html', path: 'screenshots/page.png', width: 800, height: 400 });
  check(
    'screenshot локальной страницы без сети',
    pageShot.ok === true && pageShot.result.mode === 'page-local' && pageShot.result.bytes > 1000,
    JSON.stringify(pageShot).slice(0, 320),
  );
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pageBytes = fs.readFileSync(path.join(WORKSPACE, 'screenshots', 'page.png'));
  check('screenshot страницы — настоящий PNG', pageBytes.subarray(0, 8).equals(PNG_MAGIC), pageBytes.subarray(0, 8).toString('hex'));

  // Перезапись того же файла — это обычный цикл «поправил → снял заново».
  // Раньше второй вызов падал: перед запуском браузера цель удалялась, и если
  // удаление не проходило (файл занят, запрещено политикой), инструмент отдавал
  // чужую ошибку вместо картинки.
  const pageShot2 = await tool('screenshot', { url: 'site/index.html', path: 'screenshots/page.png', width: 800, height: 400 });
  check(
    'повторный screenshot в тот же путь перезаписывает файл',
    pageShot2.ok === true && pageShot2.result.bytes > 1000,
    JSON.stringify(pageShot2).slice(0, 320),
  );
  const pageBytes2 = fs.readFileSync(path.join(WORKSPACE, 'screenshots', 'page.png'));
  check('после перезаписи файл всё ещё PNG', pageBytes2.subarray(0, 8).equals(PNG_MAGIC), pageBytes2.subarray(0, 8).toString('hex'));

  // Мусор, лежащий на месте цели, не должен пережить скриншот: иначе при сбое
  // браузера мы вернули бы успех со старым содержимым — то есть молча соврали.
  fs.writeFileSync(path.join(WORKSPACE, 'screenshots', 'stale.png'), Buffer.from('мусор вместо картинки'));
  const pageShot3 = await tool('screenshot', { url: 'site/index.html', path: 'screenshots/stale.png', width: 800, height: 400 });
  check('screenshot затирает чужой файл на месте цели', pageShot3.ok === true, JSON.stringify(pageShot3).slice(0, 320));
  const staleBytes = fs.readFileSync(path.join(WORKSPACE, 'screenshots', 'stale.png'));
  check('старое содержимое не осталось', staleBytes.subarray(0, 8).equals(PNG_MAGIC), staleBytes.subarray(0, 8).toString('hex'));

  const pageMiss = await tool('screenshot', { url: 'site/нет-такой.html', path: 'screenshots/miss.png' });
  check('screenshot отсутствующей страницы → ENOENT', pageMiss.ok === false && pageMiss.error.code === 'ENOENT', JSON.stringify(pageMiss).slice(0, 260));

  const pageJail = await tool('screenshot', { url: '../../../Windows/win.ini', path: 'screenshots/jail.png' });
  check('screenshot страницы уважает path jail', pageJail.ok === false && pageJail.error.code === 'EPATHJAIL', JSON.stringify(pageJail).slice(0, 260));

  // --- /api/raw ---
  const rawNoToken = await req('/api/raw?path=src/app.js');
  check('raw без токена — 401', rawNoToken.status === 401, String(rawNoToken.status));

  const rawOk = await fetch(`${BASE}/api/raw?path=src/app.js&token=${encodeURIComponent(TOKEN)}`);
  const rawText = await rawOk.text();
  check(
    'raw отдаёт файл по токену в query',
    rawOk.status === 200 && rawOk.headers.get('content-type').startsWith('text/javascript') && rawText.includes('console.log'),
    rawOk.status + ' ' + rawOk.headers.get('content-type'),
  );

  const rawPng = await fetch(`${BASE}/api/raw?path=screenshots/full.png&token=${encodeURIComponent(TOKEN)}`);
  check('raw отдаёт png с верным MIME', rawPng.status === 200 && rawPng.headers.get('content-type') === 'image/png', String(rawPng.headers.get('content-type')));
  await rawPng.arrayBuffer();

  const rawDl = await fetch(`${BASE}/api/raw?path=src/app.js&download=1&token=${encodeURIComponent(TOKEN)}`);
  check(
    'raw с download=1 ставит Content-Disposition',
    rawDl.status === 200 && /attachment/.test(rawDl.headers.get('content-disposition') || ''),
    String(rawDl.headers.get('content-disposition')),
  );
  await rawDl.arrayBuffer();

  const rawJail = await req('/api/raw?path=../../../Windows/win.ini&token=' + encodeURIComponent(TOKEN));
  check('raw уважает path jail', rawJail.status === 403, String(rawJail.status));

  const rawMiss = await req('/api/raw?path=нет-такого.txt&token=' + encodeURIComponent(TOKEN));
  check('raw на отсутствующий файл — 404', rawMiss.status === 404, String(rawMiss.status));

  // --- /api/open-file (проверяем только отказы, успех открыл бы окно) ---
  const ofJail = await req('/api/open-file', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ path: '../../win.ini' }),
  });
  check('open-file уважает path jail', ofJail.status === 403, String(ofJail.status));

  const ofMiss = await req('/api/open-file', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ path: 'нет-такого.txt' }),
  });
  check('open-file на отсутствующий файл — 404', ofMiss.status === 404, String(ofMiss.status));

  // --- /api/settings: смена рабочей папки ---
  const other = path.join(WORKSPACE, '..', '.test-workspace-2');
  const sw = await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ workspaceRoot: other }) });
  check(
    'смена рабочей папки через /api/settings',
    sw.json && sw.json.ok === true && sw.json.workspace === path.resolve(other) && fs.existsSync(other),
    JSON.stringify(sw.json),
  );
  const inNew = await tool('write_file', { path: 'inside.txt', content: 'ok' });
  check('в новой папке инструменты работают', inNew.ok === true, JSON.stringify(inNew).slice(0, 200));
  // Старый путь теперь резолвится внутрь НОВОЙ папки — файла там нет (ENOENT),
  // а не EPATHJAIL: тюрьма переехала вместе с рабочей папкой.
  const goneOld = await tool('read_file', { path: 'src/app.js' });
  check('после смены папки старый файл не виден', goneOld.ok === false && goneOld.error.code === 'ENOENT', JSON.stringify(goneOld).slice(0, 200));
  const newJail = await tool('read_file', { path: '../../win.ini' });
  check('новая папка тоже в тюрьме', newJail.ok === false && newJail.error.code === 'EPATHJAIL', JSON.stringify(newJail).slice(0, 200));
  await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ workspaceRoot: WORKSPACE }) });

  // --- дополнительные папки (extraRoots) ---
  // Список пуст по умолчанию, и всё снаружи отбивается — это проверено выше.
  const addRoot = await req('/api/settings', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ extraRoots: [EXTRA, EXTRA, '   ', 42, null] }),
  });
  check(
    'extraRoots применяется, дубли и мусор отброшены',
    addRoot.json && Array.isArray(addRoot.json.extraRoots) && addRoot.json.extraRoots.length === 1,
    JSON.stringify(addRoot.json),
  );

  const outsideRead = await tool('read_file', { path: path.join(EXTRA, 'outside.txt') });
  check(
    'read_file работает в дополнительной папке',
    outsideRead.ok === true && outsideRead.result.content.includes('снаружи'),
    JSON.stringify(outsideRead).slice(0, 280),
  );

  const outsideWrite = await tool('write_file', { path: path.join(EXTRA, 'created.txt'), content: 'создано моделью' });
  check('write_file пишет в дополнительную папку', outsideWrite.ok === true && fs.existsSync(path.join(EXTRA, 'created.txt')), JSON.stringify(outsideWrite).slice(0, 280));

  const outsideList = await tool('list_dir', { path: EXTRA });
  check('list_dir видит дополнительную папку', outsideList.ok === true && outsideList.result.items.some((i) => i.name === 'outside.txt'), JSON.stringify(outsideList).slice(0, 280));

  check(
    'путь вне workspace отдаётся абсолютным, а не через ../../..',
    outsideList.result.path.split(path.sep).join('/') === EXTRA.split(path.sep).join('/'),
    outsideList.result.path,
  );

  // Граница должна проверяться по разделителю: «.test-extra-other» — НЕ внутри «.test-extra».
  const sibling = await tool('read_file', { path: path.join(SIBLING, 'secret.txt') });
  check('соседняя папка с похожим именем не открывается', sibling.ok === false && sibling.error.code === 'EPATHJAIL', JSON.stringify(sibling).slice(0, 280));

  const beyondExtra = await tool('read_file', { path: path.join(EXTRA, '..', 'plan.md') });
  check('выше дополнительной папки доступа нет', beyondExtra.ok === false && beyondExtra.error.code === 'EPATHJAIL', JSON.stringify(beyondExtra).slice(0, 280));

  const extraJailCmd = await tool('run_command', { shell: 'cmd', command: 'echo hi', cwd: EXTRA });
  check('cwd в дополнительной папке разрешён', extraJailCmd.ok === true && extraJailCmd.result.exitCode === 0, JSON.stringify(extraJailCmd).slice(0, 280));

  if (process.platform === 'win32') {
    // Windows не различает регистр — путь другим регистром не должен отбиваться.
    const caseRead = await tool('read_file', { path: path.join(EXTRA.toUpperCase(), 'outside.txt') });
    check('extraRoots не зависит от регистра (Windows)', caseRead.ok === true, JSON.stringify(caseRead).slice(0, 280));
  }

  const cleared = await req('/api/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ extraRoots: [] }) });
  check('extraRoots очищается', cleared.json && cleared.json.extraRoots.length === 0, JSON.stringify(cleared.json));
  const afterClear = await tool('read_file', { path: path.join(EXTRA, 'outside.txt') });
  check('после очистки папка снова закрыта', afterClear.ok === false && afterClear.error.code === 'EPATHJAIL', JSON.stringify(afterClear).slice(0, 280));

  // --- wishlist3: новые инструменты и опции ---

  // diff (свой LCS, без зависимостей)
  await tool('write_file', { path: 'diffA.txt', content: 'one\ntwo\nthree\n' });
  await tool('write_file', { path: 'diffB.txt', content: 'one\nTWO\nthree\nfour\n' });
  const d1 = await tool('diff', { pathA: 'diffA.txt', pathB: 'diffB.txt' });
  check(
    'diff считает добавленные/удалённые строки',
    d1.ok === true && d1.result.added === 2 && d1.result.removed === 1 && d1.result.identical === false,
    JSON.stringify(d1).slice(0, 320),
  );
  check(
    'diff содержит -/+ строки',
    d1.ok === true && d1.result.diff.includes('-two') && d1.result.diff.includes('+TWO') && d1.result.diff.includes('+four'),
    JSON.stringify(d1.result && d1.result.diff).slice(0, 300),
  );
  const d2 = await tool('diff', { pathA: 'diffA.txt', pathB: 'diffA.txt' });
  check('diff одинаковых файлов → identical', d2.ok === true && d2.result.identical === true && d2.result.added === 0, JSON.stringify(d2).slice(0, 240));
  const d3 = await tool('diff', { pathA: 'diffA.txt', pathB: 'нет-такого.txt' });
  check('diff отсутствующего файла → ENOENT', d3.ok === false && d3.error.code === 'ENOENT', JSON.stringify(d3).slice(0, 240));

  // diff_git: git может быть не установлен — тогда это EGIT, и это нормально
  const dg = await tool('diff_git', { path: 'diffA.txt' });
  check('diff_git отвечает (или git не установлен)', dg.ok === true || (dg.error && dg.error.code === 'EGIT'), JSON.stringify(dg).slice(0, 240));

  // image_info
  await tool('write_binary', { path: 'img/one.png', base64: PNG_1PX.toString('base64') });
  const ii = await tool('image_info', { path: 'img/one.png' });
  check('image_info читает размеры PNG', ii.ok === true && ii.result.format === 'png' && ii.result.width === 1 && ii.result.height === 1, JSON.stringify(ii).slice(0, 260));
  const iiBad = await tool('image_info', { path: 'diffA.txt' });
  check('image_info на не-картинке → EIMAGE', iiBad.ok === false && iiBad.error.code === 'EIMAGE', JSON.stringify(iiBad).slice(0, 240));

  // find_tool
  const ft = await tool('find_tool', { name: 'node' });
  check('find_tool находит node', ft.ok === true && ft.result.found.length >= 1, JSON.stringify(ft).slice(0, 300));
  const ftEmpty = await tool('find_tool', { name: '' });
  check('find_tool без имени → EARGS', ftEmpty.ok === false && ftEmpty.error.code === 'EARGS', JSON.stringify(ftEmpty).slice(0, 200));

  // read_file: кодировка
  fs.writeFileSync(path.join(WORKSPACE, 'cp1251.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
  const encAuto = await tool('read_file', { path: 'cp1251.txt', encoding: 'auto' });
  check('read_file auto распознаёт cp1251', encAuto.ok === true && encAuto.result.content === 'Привет' && /1251/.test(encAuto.result.encoding), JSON.stringify(encAuto).slice(0, 260));
  const encUtf = await tool('read_file', { path: 'diffA.txt' });
  check('read_file обычного текста → utf-8', encUtf.ok === true && encUtf.result.encoding === 'utf-8' && encUtf.result.content.includes('one'), JSON.stringify(encUtf).slice(0, 240));
  check('read_file отдаёт detectedEncoding', encUtf.ok === true && encUtf.result.detectedEncoding === 'utf-8', JSON.stringify(encUtf).slice(0, 200));

  // Дефолт без encoding тоже должен распознавать cp1251 — раньше это требовало "auto".
  const encDefault = await tool('read_file', { path: 'cp1251.txt' });
  check('read_file без encoding распознаёт cp1251', encDefault.ok === true && encDefault.result.content === 'Привет', JSON.stringify(encDefault).slice(0, 260));

  // edit_many: dry_run
  await tool('write_file', { path: 'dry.txt', content: 'aaa\nbbb\n' });
  const dry = await tool('edit_many', { path: 'dry.txt', dry_run: true, edits: [{ old: 'bbb', new: 'BBB' }, { old: 'нет-такого', new: 'x' }] });
  check('edit_many dry_run считает без записи', dry.ok === true && dry.result.dryRun === true && dry.result.applied === 1 && dry.result.failed === 1, JSON.stringify(dry).slice(0, 360));
  const dryAfter = await tool('read_file', { path: 'dry.txt' });
  check('edit_many dry_run — файл прежний', dryAfter.result.content === 'aaa\nbbb\n', JSON.stringify(dryAfter.result.content));

  // list_dir: recursive + glob
  await tool('write_file', { path: 'deep/a/one.txt', content: 'x' });
  await tool('write_file', { path: 'deep/b/two.js', content: 'y' });
  const rec = await tool('list_dir', { path: 'deep', recursive: true, glob: '*.txt' });
  check(
    'list_dir recursive + glob фильтрует',
    rec.ok === true && rec.result.items.some((i) => i.path.endsWith('one.txt')) && !rec.result.items.some((i) => i.name === 'two.js'),
    JSON.stringify(rec).slice(0, 360),
  );

  // write_file: createDirs:false
  const noDir = await tool('write_file', { path: 'нет-папки/x.txt', content: 'x', createDirs: false });
  check('write_file createDirs:false → ENOENT', noDir.ok === false && noDir.error.code === 'ENOENT', JSON.stringify(noDir).slice(0, 240));

  // зарезервированное имя Windows: создать такой файл на этой машине нельзя,
  // поэтому delete не должен ронять мост — ждём внятную ошибку.
  const nulDel = await tool('delete', { path: 'nul' });
  check('delete зарезервированного имени не роняет мост', nulDel.ok === false && (nulDel.error.code === 'ENOENT' || nulDel.error.code === 'ERESERVED'), JSON.stringify(nulDel).slice(0, 240));

  // run_command: раскрытие %VAR% в env
  const envExp = await tool('run_command', { shell: 'cmd', command: 'echo %DSB_B%', env: { DSB_A: 'hello', DSB_B: '%DSB_A%-world' } });
  check('run_command раскрывает %VAR% в env', envExp.ok === true && String(envExp.result.stdout).includes('hello-world'), JSON.stringify(envExp).slice(0, 300));

  // --- wishlist3, часть 2: read_around, batch, память, метрики, логи ---

  // read_around: окно вокруг вхождения
  const aroundBody = Array.from({ length: 40 }, (_, i) => `line-${i + 1}${i === 19 ? ' NEEDLE' : ''}`).join('\n') + '\n';
  await tool('write_file', { path: 'around.txt', content: aroundBody });
  const ra = await tool('read_around', { path: 'around.txt', pattern: 'NEEDLE', before: 3, after: 3 });
  check(
    'read_around отдаёт окно вокруг вхождения',
    ra.ok === true && ra.result.matches === 1 && ra.result.hitLine === 20 && ra.result.fromLine === 17 && ra.result.toLine === 23 && ra.result.lines.length === 7,
    JSON.stringify(ra).slice(0, 400),
  );
  const raNone = await tool('read_around', { path: 'around.txt', pattern: 'НЕТУТАКОГО' });
  check('read_around без вхождений → matches 0', raNone.ok === true && raNone.result.matches === 0 && raNone.result.lines.length === 0, JSON.stringify(raNone).slice(0, 240));
  const raBad = await tool('read_around', { path: 'around.txt', pattern: '[' });
  check('read_around с плохим regex → EARGS', raBad.ok === false && raBad.error.code === 'EARGS', JSON.stringify(raBad).slice(0, 200));

  // batch
  const bt = await tool('batch', {
    calls: [
      { tool: 'read_file', args: { path: 'diffA.txt' } },
      { tool: 'stat', args: { path: 'diffA.txt' } },
      { tool: 'read_file', args: { path: 'нет-такого.txt' } },
    ],
  });
  check(
    'batch возвращает результаты по порядку',
    bt.ok === true && bt.result.count === 3 && bt.result.results.length === 3 && bt.result.results[0].ok === true && bt.result.results[0].result.content.includes('one') && bt.result.results[1].result.type === 'file',
    JSON.stringify(bt).slice(0, 400),
  );
  check(
    'batch считает упавшие вызовы',
    bt.result.failed === 1 && bt.result.results[2].ok === false && bt.result.results[2].error.code === 'ENOENT',
    JSON.stringify(bt.result.results[2] || {}).slice(0, 260),
  );
  const btStop = await tool('batch', {
    stopOnError: true,
    calls: [{ tool: 'read_file', args: { path: 'нет-такого.txt' } }, { tool: 'read_file', args: { path: 'diffA.txt' } }],
  });
  check('batch stopOnError останавливается на ошибке', btStop.ok === true && btStop.result.done === 1, JSON.stringify(btStop).slice(0, 300));
  const btNest = await tool('batch', { calls: [{ tool: 'batch', args: { calls: [] } }] });
  check('batch внутри batch → EBATCHNEST', btNest.ok === true && btNest.result.results[0].error.code === 'EBATCHNEST', JSON.stringify(btNest).slice(0, 300));
  const btEmpty = await tool('batch', { calls: [] });
  check('batch с пустым calls → EARGS', btEmpty.ok === false && btEmpty.error.code === 'EARGS', JSON.stringify(btEmpty).slice(0, 200));
  const btNoCalls = await tool('batch', {});
  check('batch без calls → EARGS', btNoCalls.ok === false && btNoCalls.error.code === 'EARGS', JSON.stringify(btNoCalls).slice(0, 200));

  // remember / recall / forget
  const rm1 = await tool('remember', { key: 'тест/проект', value: 'Дипсик Мост' });
  check('remember сохраняет запись', rm1.ok === true && rm1.result.stored === true && rm1.result.keys >= 1, JSON.stringify(rm1).slice(0, 280));
  await tool('remember', { key: 'тест/порт', value: 8443 });
  const rc1 = await tool('recall', { key: 'тест/проект' });
  check(
    'recall по ключу возвращает значение',
    rc1.ok === true && rc1.result.count === 1 && rc1.result.entries[0].value === 'Дипсик Мост',
    JSON.stringify(rc1).slice(0, 300),
  );
  const rc2 = await tool('recall', { pattern: 'тест/' });
  check('recall по образцу находит обе записи', rc2.ok === true && rc2.result.total === 2, JSON.stringify(rc2).slice(0, 300));
  const rc3 = await tool('recall', { key: 'нет-такого-ключа' });
  check('recall несуществующего ключа → пусто', rc3.ok === true && rc3.result.count === 0, JSON.stringify(rc3).slice(0, 240));
  const rmTtl = await tool('remember', { key: 'тест/протухший', value: 'x', ttl: 0.05 });
  await sleep(120);
  const rcTtl = await tool('recall', { key: 'тест/протухший' });
  check(
    'remember с ttl протухает и вычищается',
    rmTtl.ok === true && rcTtl.ok === true && rcTtl.result.count === 0 && rcTtl.result.expiredRemoved >= 1,
    JSON.stringify(rcTtl).slice(0, 300),
  );
  const fg1 = await tool('forget', { key: 'тест/порт' });
  check('forget удаляет ключ', fg1.ok === true && fg1.result.removed === true, JSON.stringify(fg1).slice(0, 240));
  const fgNo = await tool('forget', { key: 'нет-такого' });
  check('forget несуществующего ключа не падает', fgNo.ok === true && fgNo.result.removed === false, JSON.stringify(fgNo).slice(0, 240));
  const rmNoKey = await tool('remember', { value: 'x' });
  check('remember без ключа → EARGS', rmNoKey.ok === false && rmNoKey.error.code === 'EARGS', JSON.stringify(rmNoKey).slice(0, 200));
  const fgAll = await tool('forget', { all: true });
  check('forget all очищает память', fgAll.ok === true && fgAll.result.cleared >= 1, JSON.stringify(fgAll).slice(0, 200));
  const rcEmpty = await tool('recall', {});
  check('recall после forget all пуст', rcEmpty.ok === true && rcEmpty.result.total === 0, JSON.stringify(rcEmpty).slice(0, 200));

  // usage_stats
  const us = await tool('usage_stats', {});
  check('usage_stats считает вызовы', us.ok === true && us.result.toolsUsed > 5 && us.result.totals.calls > 10, JSON.stringify(us).slice(0, 300));
  check(
    'usage_stats знает про list_dir',
    us.result.stats.some((s) => s.tool === 'list_dir' && s.calls >= 1),
    JSON.stringify(us.result.stats.slice(0, 3)).slice(0, 300),
  );
  check('usage_stats видит ошибки', us.result.totals.errors >= 1, String(us.result.totals.errors));
  const usSort = await tool('usage_stats', { sort: 'calls', limit: 3 });
  check(
    'usage_stats сортирует по частоте',
    usSort.ok === true && usSort.result.stats.length === 3 && usSort.result.stats[0].calls >= usSort.result.stats[1].calls,
    JSON.stringify(usSort.result.stats).slice(0, 300),
  );

  // process_logs
  const pl = await tool('start_process', { shell: 'cmd', name: 'logger', command: '(echo log-line-1 & echo log-line-2 & echo log-line-3)' });
  check('start_process для process_logs запущен', pl.ok === true && pl.result.pid > 0, JSON.stringify(pl).slice(0, 260));
  await sleep(700);
  const logs = await tool('process_logs', { name: 'logger', tail: 10 });
  check('process_logs отдаёт вывод процесса', logs.ok === true && String(logs.result.stdout).includes('log-line-3'), JSON.stringify(logs).slice(0, 320));
  check(
    'process_logs отдаёт курсор nextOffset',
    logs.ok === true && logs.result.nextOffset && typeof logs.result.nextOffset.stdout === 'number',
    JSON.stringify(logs.result && logs.result.nextOffset),
  );
  const logsSince = await tool('process_logs', { name: 'logger', since: logs.result.nextOffset });
  check('process_logs since не повторяет прочитанное', logsSince.ok === true && String(logsSince.result.stdout).length === 0, JSON.stringify(logsSince).slice(0, 260));
  const logsClear = await tool('process_logs', { name: 'logger', clear: true });
  const logsAfterClear = await tool('process_logs', { name: 'logger' });
  check('process_logs clear чистит буфер', logsClear.ok === true && String(logsAfterClear.result.stdout).length === 0, JSON.stringify(logsAfterClear).slice(0, 260));
  const logsNo = await tool('process_logs', { name: 'нет-такого-процесса' });
  check('process_logs без процесса → ENOPROC', logsNo.ok === false && logsNo.error.code === 'ENOPROC', JSON.stringify(logsNo).slice(0, 200));
  await tool('kill_process', { name: 'logger' });

  // SSE: подключаемся к потоку, выполняем вызов, ждём событие в стриме
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/events?token=${encodeURIComponent(TOKEN)}`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let stream = '';
  const collector = (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stream += dec.decode(value, { stream: true });
      if (stream.includes('list_dir')) break;
    }
  })();
  await sleep(120);
  await tool('list_dir', { path: '.' });
  await collector;
  ctrl.abort();
  check('SSE доставляет события инструментов', stream.includes('list_dir'), JSON.stringify(stream.slice(0, 120)));
} catch (e) {
  fail++;
  console.log('  FAIL исключение: ' + e.message);
} finally {
  srv.kill();
  netServer.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(path.join(WORKSPACE, '..', '.test-workspace-2'), { recursive: true, force: true });
  fs.rmSync(EXTRA, { recursive: true, force: true });
  fs.rmSync(SIBLING, { recursive: true, force: true });
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
