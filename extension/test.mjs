// Тесты для content.js.
//
// content.js — это IIFE, который живёт в DOM страницы, поэтому целиком его не
// запустить в Node. Зато чистые функции (разбор data:URL, имя файла, подсчёт
// срабатываний лимита) можно вытащить прямо из исходника и проверить как есть.
// Исходник читается, а не переписывается: копия в тесте рано или поздно
// разошлась бы с боевым кодом и перестала что-либо доказывать.
//
// Запуск: node test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Настоящий реестр моста: список инструментов в промте собирается из него,
// поэтому тест обязан сверяться с оригиналом, а не с копией.
import { TOOLS } from "../bridge/src/tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "content.js"), "utf8");

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  → " + detail : ""));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ждали " + JSON.stringify(expected));
}

// Достаём тело функции по имени. Внутри IIFE всё написано с отступом в 2 пробела,
// поэтому закрывающая скобка самой функции — это "\n  }"; вложенные блоки
// закрываются глубже и под шаблон не попадают.
function extractFunction(name) {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл функцию " + name + " в content.js");
  return m[0];
}

function extractConst(name) {
  // \s* вокруг "=" — значение может уехать на следующую строку.
  const re = new RegExp("const " + name + "\\s*=\\s*([^;]+);");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл константу " + name + " в content.js");
  return m[1];
}

// Массив SITES содержит комментарии, поэтому обычный extractConst (до первой ";")
// его не возьмёт. Ищем до закрывающей скобки на отступе в два пробела.
function extractSites() {
  const m = /const SITES = (\[[\s\S]*?\n  \]);/.exec(SOURCE);
  if (!m) throw new Error("не нашёл реестр SITES в content.js");
  return m[1];
}

// --- собираем песочницу из реального кода ---
const sandbox = {};
const fnSource = [
  extractFunction("baseName"),
  extractFunction("dataUrlToFile"),
  "const RATE_RE = " + extractConst("RATE_RE") + ";",
  // Фразы лимита конкретного сайта. В песочнице сайт по умолчанию не выбран,
  // поэтому общий RATE_RE ведёт себя ровно как раньше.
  "let site = null;",
  extractFunction("siteRatePatterns"),
  extractFunction("rateLimitHits"),
].join("\n");

const factory = new Function(
  "document",
  fnSource +
    "\nreturn { baseName, dataUrlToFile, rateLimitHits, RATE_RE, useSite: (s) => { site = s; } };",
);

const fakeDocument = { body: { innerText: "" } };
const api = factory(fakeDocument);

console.log("\nbaseName");
eq("обычный путь с прямыми слэшами", api.baseName("shots/page-1.png"), "page-1.png");
eq("windows-путь с обратными слэшами", api.baseName("C:\\work\\shots\\page-1.png"), "page-1.png");
eq("абсолютный POSIX-путь", api.baseName("C:/projects/volna/src/logo.webp"), "logo.webp");
eq("смешанные разделители", api.baseName("shots\\sub/dir/pic.png"), "pic.png");
eq("пустая строка даёт запасное имя", api.baseName(""), "image.png");
eq("undefined не роняет", api.baseName(undefined), "image.png");
eq("хвостовой слэш не даёт пустое имя", api.baseName("shots/"), "shots");

console.log("\ndataUrlToFile");
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const b64 = Buffer.from(PNG_BYTES).toString("base64");
const file = api.dataUrlToFile("data:image/png;base64," + b64, "shot.png");

ok("файл создан", file instanceof File, "получили " + typeof file);
eq("имя файла сохранено", file && file.name, "shot.png");
eq("MIME из data:URL", file && file.type, "image/png");

// Байты должны совпасть ровно — иначе на сервер уедет битая картинка.
const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
eq("длина совпадает", bytes.length, PNG_BYTES.length);
eq("сигнатура PNG совпадает", Array.from(bytes).join(","), PNG_BYTES.join(","));

const empty = api.dataUrlToFile("data:image/png;base64,", "x.png");
ok("пустое тело не считается ошибкой", empty instanceof File && empty.size === 0);

const jpeg = api.dataUrlToFile("data:image/jpeg;base64,/9j/4A==", "p.jpg");
eq("JPEG MIME разобран", jpeg && jpeg.type, "image/jpeg");

// Не-base64 вариант (percent-encoded) тоже должен читаться.
const plain = api.dataUrlToFile("data:text/plain,hello%20world", "a.txt");
eq("percent-encoding разобран", plain && plain.type, "text/plain");

ok("мусор вместо data:URL → null", api.dataUrlToFile("shots/page.png", "x") === null);
ok("пустая строка → null", api.dataUrlToFile("", "x") === null);
ok("null → null", api.dataUrlToFile(null, "x") === null);

// data:URL без MIME — тип должен стать application/octet-stream, а не undefined.
const noMime = api.dataUrlToFile("data:;base64," + b64, "x.bin");
eq("отсутствующий MIME → octet-stream", noMime && noMime.type, "application/octet-stream");

console.log("\nrateLimitHits");
fakeDocument.body.innerText = "обычный ответ модели";
eq("чистый текст — 0", api.rateLimitHits(), 0);

fakeDocument.body.innerText = "Слишком частые сообщения. Повторите попытку позже";
eq("русская формулировка — 2 попадания", api.rateLimitHits(), 2);

fakeDocument.body.innerText = "Too many requests";
eq("английская формулировка", api.rateLimitHits(), 1);

fakeDocument.body.innerText = "Слишком частые сообщения";
eq("только первая половина фразы", api.rateLimitHits(), 1);

// Ключевое свойство: подсчёт не должен «залипать» из-за состояния lastIndex
// у регулярки с флагом /g. Два вызова подряд обязаны дать одно и то же число.
const twice = [api.rateLimitHits(), api.rateLimitHits()];
eq("повторный вызов даёт тот же результат", twice[0], twice[1]);

fakeDocument.body.innerText = "Слишком частые сообщения\nи ещё раз Слишком частые сообщения";
eq("два сообщения на странице — 2", api.rateLimitHits(), 2);

// --- шлюз отправки ---
// Штрафная пауза растёт вдвое с каждым пойманным лимитом, но упирается в потолок.
// Ошибка в показателе степени дала бы либо мгновенный повтор (и новый лимит),
// либо многочасовую паузу, поэтому проверяем конкретные значения.

console.log("\nштрафная пауза");

const gateSource = [
  "const sendGate = " + extractConst("sendGate") + ";",
  extractFunction("noteRateLimit"),
  extractFunction("intervalMs"),
].join("\n");

const gateApi = new Function(
  "addLog",
  "state",
  gateSource + "\nreturn { sendGate, noteRateLimit, intervalMs };",
)(() => {}, { sendIntervalSec: 4 });

const now = Date.now();
const steps = [];
for (let i = 1; i <= 5; i++) {
  gateApi.noteRateLimit();
  steps.push(Math.round((gateApi.sendGate.penaltyUntil - now) / 1000));
}

eq("штраф №1 — 10 с", steps[0], 10);
eq("штраф №2 — 20 с", steps[1], 20);
eq("штраф №3 — 40 с", steps[2], 40);
eq("штраф №4 — 80 с", steps[3], 80);
eq("штраф №5 упирается в потолок 120 с", steps[4], 120);

gateApi.noteRateLimit();
eq("штраф не растёт бесконечно", gateApi.sendGate.strike, 5);

eq("интервал из настроек — 4 с", gateApi.intervalMs(), 4000);

const gateApiZero = new Function(
  "addLog",
  "state",
  gateSource + "\nreturn { intervalMs };",
)(() => {}, { sendIntervalSec: 0 });
eq("нулевая пауза разрешена", gateApiZero.intervalMs(), 0);

const gateApiJunk = new Function(
  "addLog",
  "state",
  gateSource + "\nreturn { intervalMs };",
)(() => {}, { sendIntervalSec: "мусор" });
eq("мусор в настройке не даёт NaN", gateApiJunk.intervalMs(), 0);

// --- список инструментов для промта ---
//
// Инструкция модели больше не содержит списка инструментов руками: он собирается
// из ответа моста /api/tools. Поэтому проверяем главное — что собранный список
// совпадает с настоящим реестром. Иначе новая фича молча не попадёт в промт.
console.log("\nbuildToolList (список инструментов для промта)");

const toolListSource = [
  "const TOOL_GROUPS = " + extractConst("TOOL_GROUPS") + ";",
  extractFunction("describeTool"),
  extractFunction("buildToolList"),
].join("\n");

const toolListApi = new Function(
  toolListSource + "\nreturn { buildToolList, describeTool, TOOL_GROUPS };",
)();

eq("describeTool: аргументы через запятую",
  toolListApi.describeTool({ name: "read_file", description: "Прочитать", parameters: { path: "строка", encoding: "строка" } }),
  "- read_file {path, encoding} — Прочитать");

eq("describeTool: без параметров — без фигурных скобок",
  toolListApi.describeTool({ name: "sysinfo", description: "Информация", parameters: {} }),
  "- sysinfo — Информация");

eq("describeTool: без описания не даёт undefined",
  toolListApi.describeTool({ name: "x", parameters: {} }),
  "- x — ");

eq("describeTool: мусор на входе → null", toolListApi.describeTool(null), null);
eq("buildToolList: null → null (нет списка, будет запасной)", toolListApi.buildToolList(null), null);
eq("buildToolList: пустой массив → null", toolListApi.buildToolList([]), null);

// Сверка с настоящим реестром моста — ядро этой проверки.
const realTools = TOOLS.map((t) => t.name);
const built = toolListApi.buildToolList(TOOLS);
const builtNames = [...built.matchAll(/^- ([a-z_]+)/gm)].map((m) => m[1]);

eq("в списке столько же инструментов, сколько в реестре моста", builtNames.length, realTools.length);
eq("ни один инструмент не потерялся",
  realTools.filter((n) => !builtNames.includes(n)).join(", ") || "нет", "нет");
eq("в списке нет посторонних имён",
  builtNames.filter((n) => !realTools.includes(n)).join(", ") || "нет", "нет");
eq("дубликатов нет", new Set(builtNames).size, builtNames.length);

ok("каждый инструмент получил строку с описанием",
  TOOLS.every((t) => built.includes("- " + t.name) && built.includes(t.description)),
  "проверь description у инструментов");

ok("группы из TOOL_GROUPS попали в текст",
  toolListApi.TOOL_GROUPS.every((g) => built.includes(g.title + ":")),
  "нет какой-то группы");

// Новый инструмент, которого нет ни в одной группе, обязан попасть в «Прочее».
// Иначе добавление инструмента в мост тихо не доедет до промта.
const withNew = toolListApi.buildToolList(
  TOOLS.concat([{ name: "brand_new_tool", description: "новая фича", parameters: { x: "число" } }]),
);
ok("незнакомый инструмент уходит в «Прочее»",
  /Прочее:[\s\S]*- brand_new_tool \{x\} — новая фича/.test(withNew), withNew.slice(-160));

// Мусор от моста не должен превращаться в «список из ничего».
const junk = toolListApi.buildToolList([{ nope: 1 }, null]);
ok("мусор вместо инструментов → пусто (сработает запасной список)", !junk, JSON.stringify(junk));

ok("строки списка — только заголовки групп и пункты",
  built.split("\n").every((line) => line === "" || line.endsWith(":") || line.startsWith("- ")),
  built.split("\n").find((l) => l !== "" && !l.endsWith(":") && !l.startsWith("- ")) || "");

// --- фразы лимита конкретного сайта ---
//
// Общий RATE_RE знает русские формулировки DeepSeek и «Too many requests». У других
// чатов свои тексты, поэтому реестр сайтов добавляет их отдельно. Ошибка здесь —
// либо не пойманный лимит (и бан от чата), либо ложная штрафная пауза.
console.log("\nлимит: фразы сайта");

api.useSite({ id: "chatgpt", rateLimit: ["making requests too quickly"] });
fakeDocument.body.innerText = "You're making requests too quickly";
eq("фраза сайта считается", api.rateLimitHits(), 1);

fakeDocument.body.innerText = "Too many requests, and making requests too quickly";
eq("общая и сайтовая фразы складываются", api.rateLimitHits(), 2);

api.useSite({ id: "broken", rateLimit: ["[незакрытая скобка"] });
fakeDocument.body.innerText = "обычный ответ модели";
eq("битая регулярка не роняет подсчёт", api.rateLimitHits(), 0);

api.useSite({ id: "junk", rateLimit: "не массив" });
eq("мусор в rateLimit игнорируется", api.rateLimitHits(), 0);

api.useSite(null);
fakeDocument.body.innerText = "Too many requests";
eq("без сайта работает общий шаблон", api.rateLimitHits(), 1);

// --- реестр сайтов ---
//
// Скрипт теперь ставится на полтора десятка чатов. Разбор хоста — единственное,
// что решает, какой адаптер включится, поэтому проверяем границы, а не «серединку».
console.log("\nреестр сайтов");

const siteApi = new Function(
  "const SITES = " + extractSites() + ";\n" + extractFunction("detectSite") + "\nreturn { SITES, detectSite };",
)();

eq("chat.deepseek.com → DeepSeek", siteApi.detectSite("chat.deepseek.com").id, "deepseek");
eq("chatgpt.com → ChatGPT", siteApi.detectSite("chatgpt.com").id, "chatgpt");
eq("поддомен www.kimi.com → Kimi", siteApi.detectSite("www.kimi.com").id, "kimi");
eq("регистр хоста не важен", siteApi.detectSite("Chat.DeepSeek.com").id, "deepseek");
eq("незнакомый хост → общий адаптер", siteApi.detectSite("example.com").id, "generic");
eq("пустой хост → общий адаптер", siteApi.detectSite("").id, "generic");
eq("undefined не роняет разбор", siteApi.detectSite(undefined).id, "generic");

ok("общий адаптер ровно один и стоит последним",
  siteApi.SITES[siteApi.SITES.length - 1].id === "generic" &&
  siteApi.SITES.filter((s) => s.id === "generic").length === 1);

ok("идентификаторы сайтов уникальны",
  new Set(siteApi.SITES.map((s) => s.id)).size === siteApi.SITES.length,
  siteApi.SITES.map((s) => s.id).join(", "));

ok("у каждого сайта есть человекочитаемое имя",
  siteApi.SITES.every((s) => typeof s.name === "string" && s.name.length > 0));

// Хост, случайно попавший в два адаптера, — тихая ошибка: победит тот, что выше,
// и правки в «непобедившем» просто не будут работать.
const dupHosts = [];
const seenHosts = new Set();
for (const s of siteApi.SITES) {
  for (const h of s.hosts || []) {
    if (seenHosts.has(h)) dupHosts.push(h);
    seenHosts.add(h);
  }
}
ok("один хост не закреплён за двумя сайтами", dupHosts.length === 0, dupHosts.join(", "));

// --- селекторы, снятые с живых страниц (21.09.2026) ---
//
// Эти сайты проверены на настоящем DOM (headless Chrome + CDP): поле ввода,
// кнопка отправки, где нашлось — поле загрузки файла. Тест держит находки на
// месте: селектор, случайно выпавший при рефакторинге, ломает сайт молча.
console.log("\nселекторы сайтов (проверены на живом DOM)");

const VERIFIED = {
  qwen: { input: "textarea.message-input-textarea", send: "button.send-button" },
  zai: { input: "textarea#chat-input", send: "button#send-message-button" },
  aistudio: { input: "textarea.prompt-builder__input", send: 'button[aria-label="Run"]' },
  minimax: { input: ".tiptap.ProseMirror", send: '[data-testid="send-button"]' },
};

for (const [id, want] of Object.entries(VERIFIED)) {
  const s = siteApi.SITES.find((x) => x.id === id);
  ok("у сайта " + id + " есть селектор поля ввода",
    !!s && (s.input || []).includes(want.input), s ? JSON.stringify(s.input) : "нет сайта");
  ok("у сайта " + id + " есть селектор кнопки отправки",
    !!s && (s.send || []).includes(want.send), s ? JSON.stringify(s.send) : "нет сайта");
}

// Кнопка отправки бывает не <button>, а div с role=button (MiniMax:
// div[data-testid="send-button"]). Поэтому в общих селекторах тег не указан —
// кроме type=submit, который бывает только у настоящей кнопки.
const sendSelectors = extractConst("SEND_SELECTORS");
ok("общий селектор отправки не привязан к тегу button",
  /\[\s*data-testid="send-button"/.test(sendSelectors), sendSelectors);
ok("type=submit остался привязан к кнопке",
  /button\[type="submit"\]/.test(sendSelectors), sendSelectors);

// Кнопка-иконка без подписи сама по себе ничего не доказывает: таких на
// странице десятки. Без ограничения по близости общий путь жал карусель
// «Next slide» на AI Studio и кнопку бокового меню на MiniMax.
ok("у кнопки-иконки есть ограничение по близости к полю ввода",
  /gapToInput\(b\) <= ICON_NEAR_PX/.test(SOURCE));
ok("порог близости задан числом",
  Number.isFinite(Number(extractConst("ICON_NEAR_PX"))), extractConst("ICON_NEAR_PX"));

// Версия в панели: по скриншоту сразу видно, свежая ли сборка стоит в браузере.
ok("в чипе панели показана версия расширения",
  /dsb-site[^>]*>[\s\S]{0,90}extensionVersion\(\)/.test(SOURCE));

// --- разбор блока: JSON из текста ---
//
// У Qwen и Z.ai в контейнер блока кода попадает ещё и подпись языка, и кнопка
// «копировать». Пока разбор требовал, чтобы ВЕСЬ текст блока был JSON, такие
// блоки молча пропускались — снаружи это выглядело как «модель не отвечает
// блоками». Теперь JSON вырезается из текста по парным скобкам.
console.log("\nразбор блока: JSON из текста");

const jsonApi = new Function(
  [extractFunction("normalize"), extractFunction("jsonFromText"), "\nreturn { jsonFromText };"].join("\n"),
)();

eq("чистый JSON разбирается",
  jsonApi.jsonFromText('{ "tool": "list_dir", "args": { "path": "." } }').tool, "list_dir");
eq("подпись языка перед JSON не мешает",
  jsonApi.jsonFromText('dsbridge\n{ "tool": "read_file" }').tool, "read_file");
eq("кнопка «копировать» после JSON не мешает",
  jsonApi.jsonFromText('{ "tool": "stat" }\nКопировать').tool, "stat");
eq("неразрывный пробел внутри не ломает разбор",
  jsonApi.jsonFromText('dsbridge{ "tool": "grep", "args": { "q": "а\u00a0б" } }').args.q, "а б");
eq("закрывающая скобка внутри строки не обрывает объект",
  jsonApi.jsonFromText('{ "tool": "write_file", "args": { "text": "}" } }').args.text, "}");
eq("экранированная кавычка не ломает разбор",
  jsonApi.jsonFromText('{ "tool": "write_file", "args": { "text": "\\"}" } }').args.text, '"}' );
eq("текст без JSON не разбирается", jsonApi.jsonFromText("просто ответ модели"), null);
eq("битый JSON не разбирается", jsonApi.jsonFromText("{ не json }"), null);
eq("незакрытый объект не разбирается", jsonApi.jsonFromText('{ "tool": "x" '), null);
eq("массив не считается вызовом", jsonApi.jsonFromText("[1, 2, 3]"), null);
ok("в скане нет требования «текст начинается с {»",
  !/text\.startsWith\("\{"\)/.test(SOURCE));

// --- сигнатура вызова: по ней отличаем повтор от новой команды ---
//
// Дедупликация держится на сигнатуре: слишком грубая — пропустит законный
// повтор, слишком мелкая — не поймает перерисовку ленты при прокрутке.
console.log("\nсигнатура вызова");

const sigApi = new Function(
  [extractFunction("stableJson"), extractFunction("signatureOf"), "\nreturn { stableJson, signatureOf };"].join("\n"),
)();

eq("одинаковые вызовы дают одну сигнатуру",
  sigApi.signatureOf({ kind: "tool", tool: "read_file", args: { path: "a" } }),
  sigApi.signatureOf({ kind: "tool", tool: "read_file", args: { path: "a" } }));
ok("тот же инструмент с другими аргументами — другая сигнатура",
  sigApi.signatureOf({ kind: "tool", tool: "read_file", args: { path: "a" } }) !==
  sigApi.signatureOf({ kind: "tool", tool: "read_file", args: { path: "b" } }));
ok("разные инструменты с теми же аргументами — разные сигнатуры",
  sigApi.signatureOf({ kind: "tool", tool: "read_file", args: { path: "a" } }) !==
  sigApi.signatureOf({ kind: "tool", tool: "stat", args: { path: "a" } }));
eq("порядок ключей в аргументах не меняет сигнатуру",
  sigApi.signatureOf({ kind: "tool", tool: "edit_file", args: { path: "a", old: "x", new: "y" } }),
  sigApi.signatureOf({ kind: "tool", tool: "edit_file", args: { new: "y", old: "x", path: "a" } }));
eq("порядок ключей во вложенном объекте тоже не важен",
  sigApi.stableJson({ a: { x: 1, y: 2 }, b: [3, 4] }),
  sigApi.stableJson({ b: [3, 4], a: { y: 2, x: 1 } }));
ok("порядок элементов массива важен",
  sigApi.stableJson([1, 2]) !== sigApi.stableJson([2, 1]));
eq("картинка опознаётся по src",
  sigApi.signatureOf({ kind: "image", src: "shot.png" }), "image|shot.png");
eq("файл опознаётся по path",
  sigApi.signatureOf({ kind: "file", path: "report.md" }), "file|report.md");
ok("разные картинки — разные сигнатуры",
  sigApi.signatureOf({ kind: "image", src: "a.png" }) !== sigApi.signatureOf({ kind: "image", src: "b.png" }));

// --- манифест и реестр должны совпадать ---
//
// Самая дорогая ошибка при добавлении чата: дописать адаптер в content.js и забыть
// манифест. Тогда скрипт на сайте просто не запустится, и это выглядит как «не работает».
console.log("\nманифест расширения");

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const patterns = (manifest.content_scripts || []).flatMap((cs) => cs.matches || []);
const patternHosts = patterns
  .map((p) => (/^[a-z*]+:\/\/([^/]+)/i.exec(p) || [])[1] || "")
  .map((h) => h.toLowerCase());

const notCovered = siteApi.SITES.filter(
  (s) =>
    s.id !== "generic" &&
    (s.hosts || []).length > 0 &&
    !s.hosts.some((h) => patternHosts.some((p) => p === h || p === "*." + h)),
);
ok("каждому сайту из реестра соответствует правило в манифесте",
  notCovered.length === 0, notCovered.map((s) => s.id + " (" + s.hosts.join(",") + ")").join("; "));

ok("в манифесте не меньше 15 правил под чаты", patterns.length >= 15, String(patterns.length));

ok("правила манифеста корректны (схема, хост, путь)",
  patterns.every((p) => /^https:\/\/(\*\.)?[a-z0-9.-]+\/\S*$/i.test(p)),
  patterns.find((p) => !/^https:\/\/(\*\.)?[a-z0-9.-]+\/\S*$/i.test(p)) || "");

ok("в манифесте есть content.js и content.css",
  (manifest.content_scripts || []).some((cs) => (cs.js || []).includes("content.js") && (cs.css || []).includes("content.css")));

ok("расширению не выданы лишние разрешения",
  JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]),
  JSON.stringify(manifest.permissions));

// --- память проекта (MEMORY.md) ---
//
// Память проекта подставляется в инструкцию модели. Ошибка тут тихая: модель либо
// не увидит контекст, либо получит гигантский кусок и раздутый промт.
console.log("\nпамять проекта");

const memApi = new Function(
  [
    "const MEMORY_FILE = " + extractConst("MEMORY_FILE") + ";",
    "const MEMORY_INJECT_LIMIT = " + extractConst("MEMORY_INJECT_LIMIT") + ";",
    "let projectMemoryState = 'не прочитана';",
    extractFunction("memoryBlock"),
    extractFunction("memoryHintLevel"),
    "\nreturn { memoryBlock, memoryHintLevel, setState: (v) => { projectMemoryState = v; } };",
  ].join("\n"),
)();

ok("содержимое файла попадает в блок памяти",
  memApi.memoryBlock("# Проект\nкоманда: node test.mjs").includes("команда: node test.mjs"));
ok("в блоке назван файл памяти", memApi.memoryBlock("x").includes("MEMORY.md"));
ok("пустой файл — честная пометка, а не пустота",
  memApi.memoryBlock("").includes("файла нет или он пуст"));
ok("недоступный мост отличается от отсутствующего файла",
  memApi.memoryBlock(null).includes("мост не ответил"));
ok("пробельный файл считается пустым", memApi.memoryBlock("   \n  ").includes("файла нет или он пуст"));

const big = memApi.memoryBlock("а".repeat(9000));
ok("огромная память обрезается", big.includes("обрезано"), String(big.length));
ok("обрезанный блок не больше лимита с запасом", big.length < 4500, String(big.length));
ok("в пометке об обрезке сказано, как прочитать целиком", big.includes("read_file"));

memApi.setState("MEMORY.md — 120 символов");
eq("память подставилась — уровень ok", memApi.memoryHintLevel(), "ok");
memApi.setState("MEMORY.md нет");
eq("файла нет — уровень info", memApi.memoryHintLevel(), "info");
memApi.setState("мост не ответил");
eq("мост молчит — уровень info", memApi.memoryHintLevel(), "info");

console.log("\n" + (fail ? "Итог: " + pass + " ok, " + fail + " fail" : "Итог: " + pass + " ok, 0 fail"));
process.exit(fail ? 1 : 0);
