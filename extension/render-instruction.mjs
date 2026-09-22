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
  // \s* вокруг "=" — иначе константа, у которой значение уехало на следующую
  // строку, «не находится», и превью падает с невнятной ошибкой.
  const re = new RegExp("const " + name + "\\s*=\\s*([\\s\\S]*?);\\n");
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
  "const INSTRUCTION_MEMORY = " + extractConst("INSTRUCTION_MEMORY") + ";",
  "const INSTRUCTION_TOOLS_HEADER = " + extractConst("INSTRUCTION_TOOLS_HEADER") + ";",
  "const MEMORY_FILE = " + extractConst("MEMORY_FILE") + ";",
  "const MEMORY_INJECT_LIMIT = " + extractConst("MEMORY_INJECT_LIMIT") + ";",
  "let projectMemoryState = 'не прочитана';",
  extractFunction("describeTool"),
  extractFunction("buildToolList"),
  extractFunction("memoryBlock"),
  extractFunction("readProjectMemory"),
  extractFunction("buildInstruction"),
].join("\n");

// Заглушка chrome должна различать запросы: список инструментов и чтение памяти
// идут одним ходом (Promise.all), и один и тот же ответ на оба запроса дал бы
// «мост не ответил» вместо настоящего блока памяти.
function makeChrome(reply, memory) {
  return {
    runtime: {
      sendMessage: async (msg) => {
        if (!reply) throw new Error("мост недоступен");
        if (msg && msg.type === "tools") return reply;
        if (msg && msg.type === "tool" && msg.tool === "read_file") {
          if (memory == null) return { ok: false, error: { code: "ENOENT", message: "файла нет" } };
          return { ok: true, result: { content: memory } };
        }
        return { ok: false, error: { code: "EMSG", message: "неизвестный запрос" } };
      },
    },
  };
}

// Пример памяти проекта — как она выглядит в рабочей папке.
const SAMPLE_MEMORY = [
  "# Мой проект — заметки",
  "",
  "**Что это:** веб-приложение на Vite + React.",
  "**Команды:** `npm run dev` (порт 5173) · `npm test` (vitest).",
  "**Конвенции:** компоненты в `src/components`, стили рядом с компонентом.",
  "**Открытые хвосты:** тест на оплату падает на таймауте.",
].join("\n");

const build = (reply, memory) =>
  new Function("chrome", body + "\nreturn buildInstruction;")(makeChrome(reply, memory));

const live = await build({ ok: true, tools: TOOLS }, SAMPLE_MEMORY)();
const noMemory = await build({ ok: true, tools: TOOLS }, null)();
const dead = await build(null, null)();

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
  "«Вставить инструкцию для модели». Память проекта (MEMORY.md рабочей папки)",
  "подставляется в начало — здесь она заполнена примером.",
  "",
  "---",
  "",
].join("\n");

const footer = [
  "",
  "",
  "---",
  "",
  "## Если памяти проекта нет",
  "",
  `Вместо содержимого вставляется честная пометка (текст длиной ${noMemory.length} символов): ` +
    "«файла нет или он пуст — создай, когда появится что записать».",
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
console.log("с памятью:", live.length, "символов; без памяти:", noMemory.length, "; без моста:", dead.length);
