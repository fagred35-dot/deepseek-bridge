// Дымовой тест content.js в настоящем Chrome.
//
// Проверяет то, чего не видит обычный тест: скрипт работает в живой странице,
// а лента сообщений ведёт себя как настоящая — её перерисовывают, старые
// сообщения появляются заново, приходят новые. Именно на этом ломалась
// дедупликация вызовов (прокрутка вверх выполняла старые команды повторно).
//
// Три фазы:
//   1. обычная работа — каждый вызов выполняется ровно один раз;
//   2. имитация прокрутки вверх — лента перерисовывается с исходной разметки,
//      вызовы НЕ выполняются повторно и в чат ничего не уходит;
//   3. новое сообщение с тем же вызовом — выполняется (законные повторы целы).
//
// Запуск: node extension/smoke/run.mjs
//   DSB_CONTENT=<файл> — подменить проверяемый content.js (чтобы убедиться, что
//   тест действительно падает на старом поведении).
//
// Требует Chrome/Edge; путь можно задать через CHROME_PATH или DSBRIDGE_BROWSER.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

const { findBrowser } = await import(pathToFileURL(path.join(ROOT, "bridge/src/browser.mjs")).href);
const { runProcess } = await import(pathToFileURL(path.join(ROOT, "bridge/src/shell.mjs")).href);

// Работаем в отдельной папке: content.js копируется рядом со страницей.
const dir = path.join(os.tmpdir(), "dsb-smoke");
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(process.env.DSB_CONTENT || path.join(ROOT, "extension/content.js"), path.join(dir, "content.js"));
fs.copyFileSync(path.join(here, "index.html"), path.join(dir, "index.html"));

const exe = findBrowser();
if (!exe) throw new Error("не нашёл Chrome/Edge — задай CHROME_PATH или DSBRIDGE_BROWSER");

const profile = path.join(os.tmpdir(), "dsb-smoke-profile-" + Date.now());
const res = await runProcess({
  file: exe,
  args: [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--user-data-dir=" + profile,
    // Три фазы по 6/3/3 с — с запасом.
    "--virtual-time-budget=22000",
    "--dump-dom",
    "file:///" + path.join(dir, "index.html").replace(/\\/g, "/"),
  ],
  timeoutMs: 120000,
});

const dom = res.stdout || "";
const m = /<div id="RESULT">([\s\S]*?)<\/div>/.exec(dom);
if (!m) {
  console.log("НЕ НАШЁЛ РЕЗУЛЬТАТ. Первые 400 символов вывода:");
  console.log(dom.slice(0, 400));
  console.log("stderr:", (res.stderr || "").slice(0, 600));
  process.exit(1);
}
const text = m[1]
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ");
console.log(text.trim());
const fails = (text.match(/^FAIL /gm) || []).length;
console.log("\nитог: " + (text.match(/^OK /gm) || []).length + " ok, " + fails + " fail");
fs.rmSync(profile, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
