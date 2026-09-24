// Тесты для page-inject.js — перехватчика запросов в MAIN world.
//
// Файл целиком в Node не запустить (нужны window, fetch, XMLHttpRequest), но
// чистые функции из него достаются из исходника — как и в test.mjs. Проверяем
// две вещи: эвристику «тот ли это запрос» и вставку промпта в разные форматы тела.
//
// Запуск: node test-inject.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "page-inject.js"), "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// Функции внутри IIFE с отступом в 4 пробела — закрывающая скобка "\n  }".
function extractFunction(name) {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл функцию " + name + " в page-inject.js");
  return m[0];
}
function extractConst(name) {
  const re = new RegExp("var " + name + "\\s*=\\s*([\\s\\S]*?);");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл " + name + " в page-inject.js");
  return m[1];
}

// Собираем песочницу с нужными именами.
const sandbox = new Function(
  [
    "var location = { href: 'https://chat.deepseek.com/' };",
    "var API_HINTS = " + extractConst("API_HINTS") + ";",
    "var PATH_HINTS = " + extractConst("PATH_HINTS") + ";",
    "var EXCLUDE = " + extractConst("EXCLUDE") + ";",
    extractFunction("looksLikeChatApi"),
    extractFunction("safeStringify"),
    extractFunction("injectIntoBody"),
    "return { looksLikeChatApi, injectIntoBody };",
  ].join("\n"),
)();

console.log("эвристика запроса");
ok("POST к /api/chat — да", sandbox.looksLikeChatApi("https://chat.deepseek.com/api/chat", "POST"));
ok("GET к /api/chat — нет", !sandbox.looksLikeChatApi("https://chat.deepseek.com/api/chat", "GET"));
ok("POST к /api/health — нет (исключён)", !sandbox.looksLikeChatApi("https://x/api/health", "POST"));
ok("POST к /api/settings — нет", !sandbox.looksLikeChatApi("https://x/api/settings", "POST"));
ok("POST к /api/user/login — нет", !sandbox.looksLikeChatApi("https://x/api/user/login", "POST"));
ok("POST к /backend-api/conversation — да", sandbox.looksLikeChatApi("https://chatgpt.com/backend-api/conversation", "POST"));
ok("POST к /v1/messages — да", sandbox.looksLikeChatApi("https://api.x/v1/messages", "POST"));
ok("POST к /api/upload — нет (исключён)", !sandbox.looksLikeChatApi("https://x/api/upload", "POST"));
ok("POST к /api/feedback — нет", !sandbox.looksLikeChatApi("https://x/api/feedback", "POST"));

console.log("\nвставка в тело: messages[]");
const r1 = JSON.parse(sandbox.injectIntoBody(
  JSON.stringify({ messages: [{ role: "user", content: "привет" }] }), "СИСТЕМА"));
ok("system добавлен первым", r1.messages[0].role === "system" && r1.messages[0].content === "СИСТЕМА");
ok("user-сообщение сохранилось", r1.messages[1].content === "привет");

// Чат ВСЕГДА шлёт свой system — промпт должен ДОПОЛНИТЬ его, а не пропустить
// вставку (иначе скрытый промпт не работал бы нигде).
const r2 = JSON.parse(sandbox.injectIntoBody(
  JSON.stringify({ messages: [{ role: "system", content: "свой промпт чата" }, { role: "user", content: "x" }] }), "СИСТЕМА"));
ok("system чата дополнен, а не заменён", r2.messages[0].content === "СИСТЕМА\n\nсвой промпт чата");
ok("число сообщений не изменилось", r2.messages.length === 2);

// system как массив блоков (Claude)
const r2b = JSON.parse(sandbox.injectIntoBody(
  JSON.stringify({ messages: [{ role: "system", content: [{ type: "text", text: "блок чата" }] }, { role: "user", content: "x" }] }), "СИСТЕМА"));
ok("system-массив блоков: промпт первым блоком", r2b.messages[0].content[0].text === "СИСТЕМА" && r2b.messages[0].content[1].text === "блок чата");

console.log("\nвставка: system (Claude)");
const r3 = JSON.parse(sandbox.injectIntoBody(
  JSON.stringify({ system: "старый", messages: [{ role: "user", content: "x" }] }), "СИСТЕМА"));
ok("system-строка склеена", r3.system === "СИСТЕМА\n\nстарый");

const r4 = JSON.parse(sandbox.injectIntoBody(
  JSON.stringify({ system: [{ type: "text", text: "блок" }], messages: [] }), "СИСТЕМА"));
ok("system-массив блоков", r4.system[0].type === "text" && r4.system[0].text === "СИСТЕМА");

console.log("\nвставка: prompt и прочие поля");
const r5 = JSON.parse(sandbox.injectIntoBody(JSON.stringify({ prompt: "запрос" }), "СИСТЕМА"));
ok("prompt-строка префиксована", r5.prompt === "СИСТЕМА\n\nзапрос");

const r6 = JSON.parse(sandbox.injectIntoBody(JSON.stringify({ system_prompt: "было" }), "СИСТЕМА"));
ok("system_prompt обработан", r6.system_prompt === "СИСТЕМА\n\nбыло");

console.log("\nне трогаем чужое");
ok("нераспознанное тело — null", sandbox.injectIntoBody(JSON.stringify({ foo: "bar" }), "СИСТЕМА") === null);
ok("не-JSON — null", sandbox.injectIntoBody("не json", "СИСТЕМА") === null);
ok("пустое тело — null", sandbox.injectIntoBody("", "СИСТЕМА") === null);
ok("null — null", sandbox.injectIntoBody(null, "СИСТЕМА") === null);

console.log("\n" + (fail ? "Итог: " + pass + " ok, " + fail + " fail" : "Итог: " + pass + " ok, 0 fail"));
process.exit(fail ? 1 : 0);
