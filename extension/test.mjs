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
  const re = new RegExp("const " + name + " = ([^;]+);");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл константу " + name + " в content.js");
  return m[1];
}

// --- собираем песочницу из реального кода ---
const sandbox = {};
const fnSource = [
  extractFunction("baseName"),
  extractFunction("dataUrlToFile"),
  "const RATE_RE = " + extractConst("RATE_RE") + ";",
  extractFunction("rateLimitHits"),
].join("\n");

const factory = new Function(
  "document",
  fnSource +
    "\nreturn { baseName, dataUrlToFile, rateLimitHits, RATE_RE };",
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

console.log("\n" + (fail ? "Итог: " + pass + " ok, " + fail + " fail" : "Итог: " + pass + " ok, 0 fail"));
process.exit(fail ? 1 : 0);
