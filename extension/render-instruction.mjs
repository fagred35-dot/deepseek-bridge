// Рендер инструкции для модели в текстовый файл — чтобы вычитать её без браузера
// и сравнить с черновиком.
//
// Собирает ровно тем же кодом, что и расширение: функции вычитываются из
// content.js и исполняются в песочнице (как в test.mjs), а реестр инструментов
// берётся из настоящего bridge/src/tools.mjs. Копия тут недопустима — она
// разошлась бы с боевой и превью перестало бы что-либо показывать.
//
// Запуск: node extension/render-instruction.mjs
// Результат: INSTRUCTION.preview.md в корне проекта.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TOOLS } from "../bridge/src/tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SOURCE = readFileSync(join(here, "content.js"), "utf8");

function extractConst(name) {
  const re = new RegExp("const " + name + " = ([\\s\\S]*?);\\n");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл константу " + name + " в content.js");
  return m[1];
}

// "(async )?" — иначе у async-функции срежется ключевое слово и await перестанет
// быть валидным внутри new Function.
function extractFunction(name) {
  const re = new RegExp("(async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл функцию " + name + " в content.js");
  return m[0];
}

const body = [
  "const TOOL_GROUPS = " + extractConst("TOOL_GROUPS") + ";",
  "const FALLBACK_TOOL_NAMES = " + extractConst("FALLBACK_TOOL_NAMES") + ";",
  "const INSTRUCTION_INTRO = " + extractConst("INSTRUCTION_INTRO") + ";",
  "const INSTRUCTION_OUTRO = " + extractConst("INSTRUCTION_OUTRO") + ";",
  extractFunction("describeTool"),
  extractFunction("buildToolList"),
  extractFunction("buildInstruction"),
].join("\n");

function makeChrome(reply) {
  return { runtime: { sendMessage: async () => reply } };
}

const build = (reply) =>
  new Function("chrome", body + "\nreturn buildInstruction;")(makeChrome(reply));

const live = await build({ ok: true, tools: TOOLS })();
const dead = await build(null)();

const header = [
  "<!-- Сгенерировано: node extension/render-instruction.mjs -->",
  "<!-- Не править руками — правь extension/content.js и bridge/src/tools.mjs -->",
  "",
  "# Инструкция для модели — как её отдаёт расширение",
  "",
  `Длина: **${live.length}** символов, ${live.split("\n").length} строк, ` +
    `инструментов в реестре: **${TOOLS.length}**`,
  "",
  "Ниже — ровно тот текст, который попадает в поле ввода по кнопке",
  "«Вставить инструкцию для модели».",
  "",
  "---",
  "",
].join("\n");

const footer = [
  "",
  "",
  "---",
  "",
  "## Если мост не ответил",
  "",
  `В этом случае вставляется текст длиной ${dead.length} символов: подробного списка нет, ` +
    "вместо него — только имена инструментов и пометка. Так модель не остаётся совсем без карты.",
  "",
].join("\n");

const out = join(root, "INSTRUCTION.preview.md");
writeFileSync(out, header + live + footer, "utf8");
console.log("записано:", out);
console.log("с живым мостом:", live.length, "символов; без моста:", dead.length);
