// Тесты XML-формата вызова инструментов (альтернатива JSON в dsbridge-блоке).
//
// Функции извлекаются из исходника content.js, как и в test.mjs.
// Проверяем разбор тегов, приведение типов, экранирование и то, что старый
// JSON-формат продолжает работать (обратная совместимость).
//
// Запуск: node test-xml.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "content.js"), "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// Функции внутри IIFE с отступом в 2 пробела — закрывающая скобка "\n  }".
function extractFunction(name) {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл функцию " + name + " в content.js");
  return m[0];
}
function extractConst(name) {
  const re = new RegExp("const " + name + "\\s*=\\s*([^;]+);");
  const m = re.exec(SOURCE);
  if (!m) throw new Error("не нашёл " + name + " в content.js");
  return m[1];
}

// normalize — служебная мелочь (схлопывает неразрывные пробелы), но без неё
// разбор не соберётся. Достаём её тоже.
const sandbox = new Function(
  [
    extractFunction("normalize"),
    extractFunction("unescapeXml"),
    extractFunction("coerceXmlValue"),
    extractFunction("xmlToolFromText"),
    extractFunction("xmlFileFromText"),
    extractFunction("xmlImageFromText"),
    "return { unescapeXml, coerceXmlValue, xmlToolFromText, xmlFileFromText, xmlImageFromText };",
  ].join("\n"),
)();

console.log("xmlToolFromText — основной формат");
const t1 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="edit_file"><path>src/app.js</path><old_string>a</old_string><new_string>b</new_string></dsbridge-tool>'
);
ok("имя инструмента из атрибута", t1 && t1.tool === "edit_file");
ok("три аргумента разобраны", t1 && Object.keys(t1.args).length === 3);
ok("аргумент-строка", t1 && t1.args.path === "src/app.js");
ok("old_string и new_string", t1 && t1.args.old_string === "a" && t1.args.new_string === "b");

console.log("\nприведение типов");
const t2 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="t"><n>42</n><f>3.14</f><yes>true</yes><no>false</no><nil>null</nil></dsbridge-tool>'
);
ok("число целое → number", t2 && t2.args.n === 42 && typeof t2.args.n === "number");
ok("число дробное → number", t2 && t2.args.f === 3.14);
ok("true → boolean", t2 && t2.args.yes === true);
ok("false → boolean", t2 && t2.args.no === false);
ok("null → null", t2 && t2.args.nil === null);

console.log("\nвложенный JSON и массивы");
const t3 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="batch"><calls>[{"tool":"read_file","args":{"path":"a.md"}}]</calls></dsbridge-tool>'
);
ok("JSON-массив распознан", t3 && Array.isArray(t3.args.calls) && t3.args.calls[0].tool === "read_file");

console.log("\nэкранирование XML");
const t4 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="edit_file"><path>a.js</path><old_string>if (a &lt; b &amp;&amp; c &gt; d) { x(); }</old_string></dsbridge-tool>'
);
ok("&lt; &gt; &amp; раскрыты", t4 && t4.args.old_string === "if (a < b && c > d) { x(); }");

const t5 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="write_file"><content>он сказал &quot;привет&quot;</content></dsbridge-tool>'
);
ok("&quot; раскрыт", t5 && t5.args.content === 'он сказал "привет"');

console.log("\nмногострочные значения");
const t6 = sandbox.xmlToolFromText(
  '<dsbridge-tool name="write_file"><path>x.md</path><content>строка 1\nстрока 2\n  с отступом</content></dsbridge-tool>'
);
ok("переносы строк сохранены", t6 && t6.args.content === "строка 1\nстрока 2\n  с отступом");

console.log("\nустойчивость к мусору");
ok("без тега — null", sandbox.xmlToolFromText("просто текст") === null);
ok("без name — null", sandbox.xmlToolFromText("<dsbridge-tool><path>a</path></dsbridge-tool>") === null);
ok("без закрывающего — null", sandbox.xmlToolFromText('<dsbridge-tool name="x">') === null);
ok("пустое тело — пустые args", JSON.stringify(sandbox.xmlToolFromText('<dsbridge-tool name="sysinfo"></dsbridge-tool>').args) === "{}");

console.log("\nXML-ссылки на файл и картинку");
const f1 = sandbox.xmlFileFromText('<dsbridge-file path="report.md" label="Отчёт"/>');
ok("файл: path и label из атрибутов", f1 && f1.path === "report.md" && f1.label === "Отчёт");
const f2 = sandbox.xmlFileFromText('<dsbridge-file path="a.md"/>');
ok("файл: label по умолчанию = path", f2 && f2.label === "a.md");
const f3 = sandbox.xmlFileFromText('<dsbridge-file path="b.md">Мой файл</dsbridge-file>');
ok("файл: label из тела тега", f3 && f3.label === "Мой файл");
ok("файл без path — null", sandbox.xmlFileFromText('<dsbridge-file/>') === null);

const i1 = sandbox.xmlImageFromText('<dsbridge-image src="shot.png" alt="Скриншот"/>');
ok("картинка: src и alt", i1 && i1.src === "shot.png" && i1.alt === "Скриншот");
ok("картинка без src — null", sandbox.xmlImageFromText('<dsbridge-image/>') === null);

// ---- classify: JSON и XML должны давать ОДИН spec ----
// Это главная проверка: старый формат не должен сломаться, а новый — дать ровно
// тот же результат.
console.log("\nclassify: JSON и XML равнозначны");

const classifySandbox = new Function(
  [
    extractFunction("normalize"),
    extractFunction("jsonFromText"),
    extractFunction("unescapeXml"),
    extractFunction("coerceXmlValue"),
    extractFunction("xmlToolFromText"),
    extractFunction("xmlFileFromText"),
    extractFunction("xmlImageFromText"),
    extractFunction("classify"),
    "return { classify };",
  ].join("\n"),
)();

// Фальшивый <code>-элемент с нужным текстом и классом.
function fakeCode(text, className) {
  return {
    className: className || "",
    parentElement: null,
    textContent: text,
  };
}

const jsonSpec = classifySandbox.classify(fakeCode('{ "tool": "edit_file", "args": { "path": "a.js", "old_string": "x", "new_string": "y" } }', "language-dsbridge"));
const xmlSpec = classifySandbox.classify(fakeCode('<dsbridge-tool name="edit_file"><path>a.js</path><old_string>x</old_string><new_string>y</new_string></dsbridge-tool>', "language-dsbridge"));
ok("JSON-вызов распознан", jsonSpec && jsonSpec.kind === "tool" && jsonSpec.tool === "edit_file");
ok("XML-вызов распознан", xmlSpec && xmlSpec.kind === "tool" && xmlSpec.tool === "edit_file");
ok("оба дают одинаковый spec", JSON.stringify(jsonSpec) === JSON.stringify(xmlSpec), JSON.stringify(jsonSpec) + " vs " + JSON.stringify(xmlSpec));

const jsonFile = classifySandbox.classify(fakeCode('{ "path": "r.md", "label": "Отчёт" }', "language-dsbridge-file"));
const xmlFile = classifySandbox.classify(fakeCode('<dsbridge-file path="r.md" label="Отчёт"/>', "language-dsbridge-file"));
ok("файл: JSON распознан", jsonFile && jsonFile.kind === "file" && jsonFile.path === "r.md");
ok("файл: XML распознан", xmlFile && xmlFile.kind === "file" && xmlFile.path === "r.md");
ok("файл: specs совпадают", JSON.stringify(jsonFile) === JSON.stringify(xmlFile));

const jsonImg = classifySandbox.classify(fakeCode('{ "src": "s.png", "alt": "Скрин" }', "language-dsbridge-image"));
const xmlImg = classifySandbox.classify(fakeCode('<dsbridge-image src="s.png" alt="Скрин"/>', "language-dsbridge-image"));
ok("картинка: JSON распознан", jsonImg && jsonImg.kind === "image" && jsonImg.src === "s.png");
ok("картинка: XML распознан", xmlImg && xmlImg.kind === "image" && xmlImg.src === "s.png");
ok("картинка: specs совпадают", JSON.stringify(jsonImg) === JSON.stringify(xmlImg));

ok("блок с результатом игнорируется", classifySandbox.classify(fakeCode('{ "tool": "x" }', "dsb-result")) === null);
ok("мусорный блок — null", classifySandbox.classify(fakeCode("просто текст")) === null);

console.log("\n" + (fail ? "Итог: " + pass + " ok, " + fail + " fail" : "Итог: " + pass + " ok, 0 fail"));
process.exit(fail ? 1 : 0);
