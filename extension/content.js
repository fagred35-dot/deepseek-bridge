// Встраивается в chat.deepseek.com:
//  - панель со статусом, диагностикой и логом,
//  - распознавание блоков ```dsbridge (вызов инструмента), ```dsbridge-file (ссылка
//    на файл), ```dsbridge-image (картинка) — блоки внутри «Размышления» игнорируются,
//  - исходный JSON красиво сворачивается, вместо него компактная карточка,
//  - несколько вызовов в одном сообщении выполняются по порядку и уходят одним ответом,
//  - скриншоты прикрепляются к сообщению как файл — тогда модель видит картинку,
//  - отправка идёт через шлюз с паузой, иначе DeepSeek отвечает «Слишком частые сообщения».
(() => {
  const PANEL_ID = "dsbridge-panel";
  const pending = new WeakMap();
  // Сигнатура -> время последнего выполнения. Ограничено окном, поэтому карта
  // не растёт вместе с историей чата.
  const recent = new Map();
  const DEDUP_WINDOW_MS = 5000;
  const state = {
    auto: true,
    autoSend: true,
    autoAttach: true,
    sendIntervalSec: 4,
    connected: false,
    scanned: 0,
    matched: 0,
    skipped: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- настройки панели ----------
  // Живут в chrome.storage.local: перезагрузка страницы не должна сбрасывать
  // выставленную паузу.

  const SETTINGS_KEY = "uiSettings";

  async function loadSettings() {
    try {
      const bag = await chrome.storage.local.get(SETTINGS_KEY);
      const saved = bag && bag[SETTINGS_KEY];
      if (!saved || typeof saved !== "object") return;
      if (typeof saved.auto === "boolean") state.auto = saved.auto;
      if (typeof saved.autoSend === "boolean") state.autoSend = saved.autoSend;
      if (typeof saved.autoAttach === "boolean") state.autoAttach = saved.autoAttach;
      const n = Number(saved.sendIntervalSec);
      if (Number.isFinite(n)) state.sendIntervalSec = Math.min(120, Math.max(0, n));
    } catch {
      // storage недоступен — остаёмся на значениях по умолчанию
    }
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({
        [SETTINGS_KEY]: {
          auto: state.auto,
          autoSend: state.autoSend,
          autoAttach: state.autoAttach,
          sendIntervalSec: state.sendIntervalSec,
        },
      });
    } catch {
      // не критично: настройки просто не переживут перезагрузку
    }
  }

  // ---------- тормоз отправки ----------
  // DeepSeek отвечает «Слишком частые сообщения. Повторите попытку позже», если
  // писать слишком часто. Поэтому отправка идёт через шлюз: минимальный интервал
  // между сообщениями плюс штрафная пауза, если лимит всё-таки поймали.

  const sendGate = { lastAt: 0, penaltyUntil: 0, strike: 0 };
  const RATE_RE = /Слишком частые сообщения|Повторите попытку позже|Too many requests|rate limit/gi;

  // Считаем вхождения, а не «есть/нет»: сообщение об ошибке может висеть в чате
  // с прошлой попытки, и тогда сравнение «до/после» ловит именно новое.
  function rateLimitHits() {
    const text = document.body.innerText || "";
    RATE_RE.lastIndex = 0;
    let n = 0;
    while (RATE_RE.exec(text) !== null) n++;
    return n;
  }

  function setGateHint(text) {
    const node = document.getElementById("dsb-gate");
    if (node) node.textContent = text || "";
  }

  function intervalMs() {
    return Math.max(0, Number(state.sendIntervalSec) || 0) * 1000;
  }

  async function waitForSendSlot() {
    while (Date.now() < sendGate.penaltyUntil) {
      const left = Math.ceil((sendGate.penaltyUntil - Date.now()) / 1000);
      setGateHint("лимит DeepSeek — пауза " + left + " с");
      await sleep(500);
    }
    const gap = Date.now() - sendGate.lastAt;
    const need = intervalMs();
    if (gap < need) {
      const wait = need - gap;
      setGateHint("пауза перед отправкой " + (wait / 1000).toFixed(1) + " с");
      addLog("пауза перед отправкой: " + (wait / 1000).toFixed(1) + " с");
      await sleep(wait);
    }
    setGateHint("");
  }

  function noteRateLimit() {
    sendGate.strike = Math.min(sendGate.strike + 1, 5);
    const wait = Math.min(120000, 10000 * Math.pow(2, sendGate.strike - 1));
    sendGate.penaltyUntil = Date.now() + wait;
    addLog(
      "поймал лимит DeepSeek — пауза " + Math.round(wait / 1000) + " с (штраф №" + sendGate.strike + ")",
      "error",
    );
  }

  // Пока модель отвечает, DeepSeek держит на месте кнопки отправки кнопку «стоп».
  // Клик по ней оборвал бы ответ вместо отправки, поэтому ждём конца генерации.
  //
  // Признак намеренно узкий — только метка кнопки. Угадывать по форме иконки
  // опасно: ложное срабатывание заставило бы ждать на каждой отправке.
  function isGenerating() {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.some((b) =>
      /stop|останов/i.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")),
    );
  }

  async function waitForGenerationEnd(maxMs = 20000) {
    const started = Date.now();
    let announced = false;
    while (Date.now() - started < maxMs) {
      if (!isGenerating()) return true;
      if (!announced) {
        setGateHint("ждём, пока DeepSeek договорит");
        addLog("модель ещё отвечает — держу сообщение до конца генерации");
        announced = true;
      }
      await sleep(400);
    }
    if (announced) {
      addLog("генерация не закончилась за " + Math.round(maxMs / 1000) + " с — отправляю как есть", "error");
    }
    return false;
  }

  // ---------- инструкция для модели ----------
  //
  // Текст собран из трёх частей: статичная проза до списка, сам список
  // инструментов и проза после. Список собирается из ответа моста /api/tools,
  // поэтому промт не разъезжается с реестром TOOLS: добавил инструмент в мост —
  // он сам появился в инструкции. Раньше список дублировался руками и отставал
  // от кода (например, новые инструменты в нём не появлялись вовсе).

  const INSTRUCTION_INTRO = [
    "Ты работаешь автономно с локальными файлами через инструменты.",
    "Не спрашивай разрешения и не пиши «давай я прочитаю этот файл» — просто вызови инструмент.",
    "",
    "Чтобы вызвать инструмент, выведи блок кода с языком dsbridge и валидным JSON:",
    "",
    "```dsbridge",
    '{ "tool": "list_dir", "args": { "path": "." } }',
    "```",
    "",
    "Кроме dsbridge есть ещё два языка блоков — ссылка на файл и картинка:",
    "",
    "```dsbridge-file",
    '{ "path": "report.md", "label": "Отчёт" }',
    "```",
    "",
    "```dsbridge-image",
    '{ "src": "shot.png", "alt": "Скриншот" }',
    "```",
    "",
    "Несколько блоков dsbridge подряд выполнятся по порядку; ответ уходит одним сообщением.",
    "",
    "СКОЛЬКО ВЫЗОВОВ ЗА СООБЩЕНИЕ",
    "- По умолчанию — ОДИН: дождись результата и продолжай сам.",
    "- Несколько НЕЗАВИСИМЫХ вызовов можно объединить в один ответ — выполнятся по порядку.",
    "  Не объединяй, если следующий вызов зависит от результата предыдущего.",
    "- Если вызовов сразу много (прочитать 5 файлов, grep, stat) — бери batch: одно сообщение",
    "  вместо пяти, и лимит «Слишком частые сообщения» не так быстро кончается.",
    "",
    "ЗРЕНИЕ — как увидеть результат",
    "- Скриншоты из screenshot расширение прикрепляет к следующему сообщению автоматически",
    "  (если в панели включена галочка прикрепления картинок). Ты получаешь картинку",
    "  мультимодально и реально ВИДИШЬ её, а не только путь к файлу.",
    "- Блок dsbridge-image { \"src\": \"локальный/путь.png\" } прикрепляет картинку так же —",
    "  это надёжный способ показать результат самому себе.",
    "- Прикрепляются только ЛОКАЛЬНЫЕ файлы рабочей папки. Ссылку http(s) видит лишь пользователь.",
    "- Цикл проверки вёрстки: собрал → screenshot {url: \"index.html\"} → посмотрел, что реально",
    "  нарисовано → поправил через edit_file → снял снова и сравнил. Длинная страница —",
    "  fullPage: true, мобильный вид — device: \"mobile\".",
    "- НИКОГДА не выдумывай, что на картинке. Не пришла или пришла нечитаемой — скажи об этом",
    "  прямо, а не описывай то, что рассчитывал увидеть по своему же коду.",
    "",
    "ИНСТРУМЕНТЫ (список собран из реестра моста; в фигурных скобках — имена аргументов)",
    "",
  ].join("\n");

  // Группы — только для читаемости. Инструмент, которого нет ни в одной группе,
  // попадает в «Прочее»: новый tool физически не может потеряться в промте.
  const TOOL_GROUPS = [
    {
      title: "Файлы и папки",
      tools: [
        "list_dir", "tree", "read_file", "read_lines", "read_around", "write_file",
        "edit_file", "edit_many", "write_binary", "make_dir", "move", "copy", "delete", "stat",
      ],
    },
    { title: "Поиск", tools: ["search", "grep"] },
    { title: "Сравнение", tools: ["diff", "diff_git"] },
    { title: "Картинки", tools: ["image_info", "screenshot"] },
    {
      title: "Процессы и команды",
      tools: ["run_command", "start_process", "list_processes", "process_logs", "kill_process"],
    },
    { title: "Git", tools: ["git"] },
    { title: "Система", tools: ["sysinfo", "find_tool", "list_windows", "zip", "unzip", "hash"] },
    { title: "Память между чатами", tools: ["remember", "recall", "forget"] },
    { title: "Пакетный вызов", tools: ["batch"] },
    { title: "Метрики", tools: ["usage_stats"] },
    { title: "Сеть (нужен флаг «Сетевой доступ»)", tools: ["download", "http_get", "http_post"] },
  ];

  // Запасной список имён на случай, если мост не ответил: без него модель слепа.
  const FALLBACK_TOOL_NAMES = [
    "list_dir", "tree", "read_file", "read_lines", "read_around", "write_file", "edit_file",
    "edit_many", "write_binary", "make_dir", "move", "copy", "delete", "stat", "search", "grep",
    "diff", "diff_git", "image_info", "screenshot", "run_command", "start_process",
    "list_processes", "process_logs", "kill_process", "git", "sysinfo", "find_tool",
    "list_windows", "zip", "unzip", "hash", "remember", "recall", "forget", "batch",
    "usage_stats", "download", "http_get", "http_post",
  ];

  function describeTool(t) {
    if (!t || !t.name) return null;
    const keys = t.parameters && typeof t.parameters === "object" ? Object.keys(t.parameters) : [];
    const args = keys.length ? " {" + keys.join(", ") + "}" : "";
    return "- " + t.name + args + " — " + (t.description || "");
  }

  function buildToolList(tools) {
    if (!Array.isArray(tools) || !tools.length) return null;
    const byName = new Map();
    for (const t of tools) if (t && t.name) byName.set(t.name, t);

    const used = new Set();
    const lines = [];
    for (const group of TOOL_GROUPS) {
      const rows = [];
      for (const name of group.tools) {
        const t = byName.get(name);
        if (!t) continue;
        used.add(name);
        const row = describeTool(t);
        if (row) rows.push(row);
      }
      if (!rows.length) continue;
      lines.push(group.title + ":");
      for (const row of rows) lines.push(row);
      lines.push("");
    }

    const rest = tools.filter((t) => t && t.name && !used.has(t.name));
    if (rest.length) {
      lines.push("Прочее:");
      for (const t of rest) {
        const row = describeTool(t);
        if (row) lines.push(row);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const INSTRUCTION_OUTRO = [
    "ПРЕЖДЕ ЧЕМ ЗВАТЬ run_command",
    "Проверь, нет ли специализированного инструмента — он безопаснее и НЕ требует флага",
    "«Выполнение команд»: Get-FileHash / certutil → hash · Select-String / findstr → grep ·",
    "Get-ChildItem -Recurse → tree или list_dir recursive · Get-Content -TotalCount → read_lines ·",
    "where / Get-Command → find_tool · git через шелл → git · Compress-Archive → zip / unzip.",
    "",
    "КОГДА НЕ ДЕЙСТВОВАТЬ МОЛЧА",
    "Без явной просьбы не делай необратимое: не удаляй папку целиком, не запускай git reset --hard",
    "или git clean -fd, не глуши чужие процессы, не делай forget { all: true }. Сомневаешься — спроси.",
    "ОТДЕЛЬНО: никогда не вызывай taskkill /F /IM node.exe и вообще не глуши процессы по имени",
    "образа. Мост работает на Node — ты убьёшь сам мост, и связь оборвётся до перезапуска.",
    "Свой фоновый процесс останавливай через kill_process { pid } или { name }.",
    "",
    "ОСОБЕННОСТИ WINDOWS",
    "- java, node, dotnet, gradle, python могут быть установлены, но не в PATH. Сначала",
    "  find_tool { name: \"node\" }, потом run_command по полному пути. Иногда shell: \"cmd\"",
    "  срабатывает там, где PowerShell падает.",
    "- В значениях env мост сам раскрывает %VAR% и ${VAR}, поэтому дописать к PATH можно так:",
    "  { \"Path\": \"C:\\\\jdk\\\\bin;%Path%\" }.",
    "- В PowerShell вызов & 'C:\\путь\\к.exe' -version иногда падает с CantActivateDocumentInPipeline.",
    "  Обход: shell: \"cmd\" или редирект в файл (2>&1).",
    "- Имена nul, con, aux, prn, com1-9, lpt1-9 Windows считает устройствами. Прочитать такой файл",
    "  и посмотреть stat можно, а создать, переименовать или удалить — нет: мост вернёт ERESERVED.",
    "  Не бейся об это, просто оставь файл в покое.",
    "",
    "ФЛАГИ МОСТА",
    "Включаются в UI моста. Если инструмент вернул EDISABLED — скажи пользователю, какой флаг",
    "включить, и НЕ повторяй вызов.",
    "- «Выполнение команд» — run_command, изменяющие команды git, start_process, kill_process.",
    "- «Сетевой доступ» — download, http_get, http_post и screenshot по http(s)-адресу.",
    "  Локальные файлы рендерятся без сети.",
    "",
    "КОДЫ ОШИБОК",
    "EPATHJAIL  — путь вне разрешённых папок. Проверь опечатку; если папка добавлена в настройках",
    "             моста — используй абсолютный путь.",
    "ENOENT     — файла или папки нет. Проверь имя через list_dir.",
    "EISDIR     — ждали файл, а это папка.",
    "ETOOLARGE  — файл больше лимита. Читай через read_lines или run_command.",
    "EAMBIGUOUS — old_string встречается больше одного раза. Дай больше контекста или replace_all.",
    "ENOMATCH   — old_string не найдена. Перечитай файл и скопируй фрагмент точно.",
    "EARGS      — плохие аргументы, подробности в message.",
    "EDISABLED  — флаг выключен в UI моста. Попроси включить, не повторяй.",
    "EBRIDGE    — связь с расширением оборвалась. Подожди пару секунд и повтори.",
    "ENOTOOL    — мост не знает такого инструмента. Скорее всего запущен старый exe или старая",
    "             копия моста: скажи пользователю и сверься со списком выше.",
    "ENOPROC    — процесс не найден. Посмотри list_processes.",
    "ELIMIT     — превышен лимит (batch до 50, память до 500 ключей). Разбей на части.",
    "EBATCHNEST — batch внутри batch. Не вкладывай.",
    "ESHOT / EWIN — скриншот или список окон не удались. Проверь путь и имя окна.",
    "EIMAGE     — файл не похож на картинку. Посмотри image_info.",
    "ERESERVED  — зарезервированное имя Windows. См. выше.",
    "EGIT / ESHELL / EHTTP / ENET / EBADURL / EZIP / EUNZIP — подвёл внешний инструмент,",
    "             подробности в message.",
    "EUNKNOWN   — смотри message.",
    "",
    "ПАМЯТЬ МЕЖДУ ЧАТАМИ",
    "remember { key, value, ttl? } пишет в memory.json в папке данных моста и переживает",
    "перезагрузку: заметка будет доступна в следующем чате. Полезно для решений о проекте, путей",
    "к частым файлам и контекста длинной задачи. recall {} вернёт всё, recall { key } — одно",
    "значение, recall { pattern } — поиск по ключам и значениям. Лимит 500 ключей, значения не",
    "обрезаются. Не злоупотребляй: это память, а не свалка.",
    "",
    "ПРО .trash",
    "delete не удаляет безвозвратно, а переносит в <workspace>/.trash/. Вернуть файл:",
    "move { from: \".trash/1234567_file.txt\", to: \"file.txt\" }.",
    "",
    "ТОНКОСТИ, КОТОРЫЕ ЭКОНОМЯТ ХОДЫ",
    "- Файлы могут меняться во время сессии (идёт сборка, работает другой процесс). Если grep",
    "  не находит то, что должно быть, — перечитай файл, прежде чем делать вывод.",
    "- read_file по умолчанию читает как UTF-8. Для старых Windows-файлов (cp1251/cp866) бери",
    "  encoding: \"auto\" — мост определит кодировку и скажет, что распознал.",
    "- При пересборке моста вызовы могут молча теряться (EBRIDGE). Это НЕ «лимит шагов»: связь",
    "  рвётся, файлы на диске целы. Подожди и повтори.",
    "- Пути наружу отдаются в POSIX-виде (/), а для дополнительных папок — абсолютными. Не",
    "  удивляйся пути, начинающемуся с C:/.",
    "",
    "РАБОЧИЕ ПРОЦЕССЫ",
    "Правка файла: read_file → edit_file (одна правка) или edit_many (несколько); при сомнениях",
    "сначала edit_many { dry_run: true }.",
    "Отладка сервера: start_process → process_logs { waitMs: 2000 } → screenshot → kill_process.",
    "Сборка проекта: find_tool (узнать путь) → run_command с env → read_lines { tail: 100 } по логу.",
    "",
    "ПРАВИЛА",
    "- Дождись результата и продолжай сам, без лишних вопросов.",
    "- Если просят посмотреть, найти, создать, изменить или выполнить — сразу вызывай инструмент.",
    "- Пути — относительно рабочей папки, команды выполняются в ней же.",
    "- Если в настройках моста добавлены дополнительные папки, работать можно и в них: используй",
    "  АБСОЛЮТНЫЙ путь (например \"C:\\projects\\volna\\src\\app.js\") — относительный всегда",
    "  считается от рабочей папки. В ответах инструментов такие файлы тоже приходят абсолютными.",
    "  За пределы рабочей папки и этого списка выходить нельзя.",
    "- Ссылка на файл в ответе: блок dsbridge-file с JSON {\"path\": \"report.md\", \"label\": \"Отчёт\"}.",
    "- Ты не генератор кода, а исполнитель: сначала посмотри, потом сделай, потом проверь.",
  ].join("\n");

  // Список берём у моста: если он не ответил, отдаём хотя бы имена, чтобы модель
  // не осталась совсем без карты инструментов.
  async function buildInstruction() {
    let tools = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "tools" });
      if (res && res.ok && Array.isArray(res.tools)) tools = res.tools;
    } catch {
      tools = null;
    }
    const list = buildToolList(tools);
    const body = list
      ? list
      : "(мост не ответил — подробный список недоступен; имена инструментов: " +
        FALLBACK_TOOL_NAMES.join(", ") +
        ")\n";
    return INSTRUCTION_INTRO + "\n" + body + "\n" + INSTRUCTION_OUTRO;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- панель ----------

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = el("div");
    panel.id = PANEL_ID;
    panel.innerHTML = [
      '<div class="dsb-head">',
      '  <span class="dsb-dot" id="dsb-dot"></span>',
      '  <span class="dsb-title">Дипсик Мост</span>',
      '  <span class="dsb-status" id="dsb-status">проверка…</span>',
      '  <button class="dsb-x" id="dsb-toggle" title="Свернуть">–</button>',
      "</div>",
      '<div class="dsb-body" id="dsb-body">',
      '  <label class="dsb-row"><input type="checkbox" id="dsb-auto" checked> авто-выполнение</label>',
      '  <label class="dsb-row"><input type="checkbox" id="dsb-send" checked> авто-отправка результата</label>',
      '  <label class="dsb-row"><input type="checkbox" id="dsb-attach" checked> прикреплять картинки в чат</label>',
      '  <label class="dsb-row"><span class="dsb-lbl">пауза между отправками</span>',
      '    <input type="number" id="dsb-gap" min="0" max="120" step="1" value="4"><span class="dsb-unit">с</span></label>',
      '  <div class="dsb-gate" id="dsb-gate"></div>',
      '  <div class="dsb-btns">',
      '    <button class="dsb-btn" id="dsb-instr">Инструкция</button>',
      '    <button class="dsb-btn" id="dsb-scan">Сканировать</button>',
      '    <button class="dsb-btn" id="dsb-dom" title="Показать, какие блоки видит расширение">DOM</button>',
      "  </div>",
      '  <div class="dsb-diag" id="dsb-diag">сканирую…</div>',
      '  <div class="dsb-log" id="dsb-log"></div>',
      "</div>",
    ].join("");
    document.body.appendChild(panel);

    panel.querySelector("#dsb-toggle").addEventListener("click", () => {
      panel.classList.toggle("dsb-collapsed");
      panel.querySelector("#dsb-toggle").textContent = panel.classList.contains("dsb-collapsed") ? "+" : "–";
    });
    panel.querySelector("#dsb-auto").addEventListener("change", (e) => {
      state.auto = e.target.checked;
      saveSettings();
      addLog(state.auto ? "авто-выполнение включено" : "авто-выполнение выключено");
    });
    panel.querySelector("#dsb-send").addEventListener("change", (e) => {
      state.autoSend = e.target.checked;
      saveSettings();
      addLog(state.autoSend ? "авто-отправка включена" : "авто-отправка выключена");
    });
    panel.querySelector("#dsb-attach").addEventListener("change", (e) => {
      state.autoAttach = e.target.checked;
      saveSettings();
      addLog(state.autoAttach ? "картинки прикрепляются в чат" : "прикрепление картинок выключено");
    });
    panel.querySelector("#dsb-gap").addEventListener("change", (e) => {
      const n = Number(e.target.value);
      state.sendIntervalSec = Number.isFinite(n) ? Math.min(120, Math.max(0, n)) : 4;
      e.target.value = String(state.sendIntervalSec);
      saveSettings();
      addLog("пауза между отправками: " + state.sendIntervalSec + " с");
    });
    panel.querySelector("#dsb-instr").addEventListener("click", async () => {
      const text = await buildInstruction();
      const ok = insertIntoInput(text);
      addLog(
        ok ? "инструкция вставлена в поле ввода (" + text.length + " символов)" : "не нашёл поле ввода",
        ok ? "ok" : "error",
      );
    });
    panel.querySelector("#dsb-scan").addEventListener("click", () => scan(true));
    panel.querySelector("#dsb-dom").addEventListener("click", dumpDom);
  }

  function applySettingsToPanel() {
    const set = (id, value) => {
      const node = document.getElementById(id);
      if (!node) return;
      if (node.type === "checkbox") node.checked = !!value;
      else node.value = String(value);
    };
    set("dsb-auto", state.auto);
    set("dsb-send", state.autoSend);
    set("dsb-attach", state.autoAttach);
    set("dsb-gap", state.sendIntervalSec);
  }

  function addLog(message, level = "info") {
    const box = document.getElementById("dsb-log");
    if (!box) return;
    const line = el("div", "dsb-ev dsb-" + level, message);
    box.append(line);
    box.scrollTop = box.scrollHeight;
  }

  function setDiag(text) {
    const d = document.getElementById("dsb-diag");
    if (d) d.textContent = text;
  }

  function setStatus(ok, text) {
    state.connected = ok;
    const dot = document.getElementById("dsb-dot");
    const st = document.getElementById("dsb-status");
    if (dot) dot.className = "dsb-dot " + (ok ? "on" : "off");
    if (st) st.textContent = text || (ok ? "подключено" : "нет связи");
  }

  async function pollHealth() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "health" });
      if (res && res.ok) setStatus(true, "подключено");
      else if (res && res.error && res.error.code === "EAUTH") setStatus(false, "нет токена");
      else setStatus(false, (res && res.error && res.error.message) || "нет связи");
    } catch {
      setStatus(false, "нет связи");
    }
  }

  // ---------- «Размышление» ----------

  let rootsCache = { at: 0, set: new Set() };

  function reasoningRoots() {
    const now = Date.now();
    if (now - rootsCache.at < 1500) return rootsCache.set;

    const roots = new Set();
    document.querySelectorAll("[class]").forEach((node) => {
      const cls = typeof node.className === "string" ? node.className : "";
      if (cls && /think|reason|thought|размышл/i.test(cls)) roots.add(node);
    });
    const re = /^(Размышление|Размышляю|Reasoning|Thinking|Thought|思考)/i;
    document.querySelectorAll("div, span, button, summary").forEach((node) => {
      if (node.children.length > 2) return;
      const t = node.textContent.trim();
      if (t.length > 0 && t.length <= 40 && re.test(t)) {
        if (node.nextElementSibling) roots.add(node.nextElementSibling);
        const parent = node.parentElement;
        if (parent && parent.children.length <= 2 && parent !== document.body) roots.add(parent);
      }
    });

    rootsCache = { at: now, set: roots };
    return roots;
  }

  function inAny(node, roots) {
    for (const root of roots) {
      if (root === node || root.contains(node)) return true;
    }
    return false;
  }

  // ---------- распознавание блоков ----------

  function normalize(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .trim();
  }

  function classify(codeEl) {
    const cls = typeof codeEl.className === "string" ? codeEl.className : "";
    const parentCls = codeEl.parentElement && typeof codeEl.parentElement.className === "string" ? codeEl.parentElement.className : "";
    const label = cls + " " + parentCls;
    if (/result/i.test(label)) return null;

    const t = normalize(codeEl.textContent);
    if (!t.startsWith("{")) return null;
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      return null;
    }
    if (!json || typeof json !== "object") return null;

    if (typeof json.tool === "string") {
      return { kind: "tool", tool: json.tool, args: json.args && typeof json.args === "object" ? json.args : {} };
    }
    if (/dsbridge-image/i.test(label) || typeof json.src === "string") {
      return { kind: "image", src: String(json.src || json.path || ""), alt: String(json.alt || "") };
    }
    if (/dsbridge-file/i.test(label) || (typeof json.path === "string" && (json.label || /dsbridge-file/i.test(label)))) {
      return { kind: "file", path: String(json.path || ""), label: String(json.label || json.path || "") };
    }
    return null;
  }

  // Защита от повторного выполнения одного и того же блока, если DeepSeek
  // перерисует сообщение и создаст для него новые DOM-узлы.
  function isDuplicate(sig) {
    const now = Date.now();
    for (const [key, at] of recent) {
      if (now - at > DEDUP_WINDOW_MS) recent.delete(key);
    }
    const last = recent.get(sig);
    if (last != null && now - last <= DEDUP_WINDOW_MS) return true;
    recent.set(sig, now);
    return false;
  }

  function candidateNodes() {
    const out = [];
    const push = (node) => {
      if (!node || out.includes(node)) return;
      if (node.closest("#" + PANEL_ID + ", .dsb-result, .dsb-image-card, .dsb-file-card")) return;
      out.push(node);
    };
    document.querySelectorAll("pre, code").forEach(push);
    document.querySelectorAll('[class*="code"], [class*="Code"]').forEach((node) => {
      if (node.querySelector("pre, code")) return;
      if (/\{\s*"(tool|src|path)"/.test(node.textContent)) push(node);
    });
    return out;
  }

  function chainOf(node) {
    const parts = [];
    let cur = node;
    let i = 0;
    while (cur && i < 9) {
      const cls = cur.className && typeof cur.className === "string" ? cur.className.slice(0, 36) : "—";
      parts.push(cur.tagName.toLowerCase() + "." + cls);
      cur = cur.parentElement;
      i++;
    }
    return parts.join("  <  ");
  }

  function dumpDom() {
    const nodes = candidateNodes().filter((n) => n.textContent.trim().startsWith("{"));
    addLog("блоков с JSON: " + nodes.length);
    nodes.slice(0, 6).forEach((n, i) => addLog("#" + (i + 1) + " " + chainOf(n)));
  }

  // ---------- карточка вызова ----------

  function hideRawBlock(codeEl) {
    const block = codeEl.closest("pre") || codeEl;
    block.style.display = "none";
    return block;
  }

  function renderCallCard(codeEl, call) {
    const anchor = codeEl.closest("pre") || codeEl;
    const block = anchor;
    const card = el("div", "dsb-result");
    const head = el("div", "dsb-res-head");
    const title = el("span", "dsb-res-tool", "⚙ " + call.tool);
    const stateEl = el("span", "dsb-res-state", "в очереди");
    const codeBtn = el("button", "dsb-mini", "код");
    head.append(title, stateEl, codeBtn);

    const body = el("div", "dsb-res-collapse");
    card.append(head, body);
    anchor.after(card);

    codeBtn.addEventListener("click", () => {
      const hidden = block.style.display === "none";
      block.style.display = hidden ? "" : "none";
      codeBtn.textContent = hidden ? "скрыть код" : "код";
    });

    block.style.display = "none";
    return { card, body, stateEl };
  }

  function resultText(toolName, payload) {
    return "Результат инструмента " + toolName + ":\n\n```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  }

  // ---------- пакетная очередь вызовов ----------

  const queue = [];
  let queueTimer = null;

  function enqueue(call, codeEl) {
    const ui = renderCallCard(codeEl, call);
    queue.push({ call, ui });
    clearTimeout(queueTimer);
    queueTimer = setTimeout(flushQueue, 800);
  }

  async function callTool(call) {
    try {
      return await chrome.runtime.sendMessage({ type: "tool", tool: call.tool, args: call.args });
    } catch (e) {
      return { ok: false, error: { code: "EBRIDGE", message: String(e) } };
    }
  }

  async function flushQueue() {
    const items = queue.splice(0, queue.length);
    if (!items.length) return;
    addLog("выполняю вызовов: " + items.length);

    const summary = [];
    const images = [];

    for (const item of items) {
      const { call, ui } = item;
      ui.stateEl.textContent = "выполняется…";
      addLog("→ " + call.tool + " " + JSON.stringify(call.args), "info");

      const res = await callTool(call);
      const ok = !!(res && res.ok);
      ui.stateEl.className = "dsb-res-state " + (ok ? "ok" : "err");
      ui.stateEl.textContent = ok ? "готово" : "ошибка";
      addLog((ok ? "✓ " : "✗ ") + call.tool, ok ? "ok" : "error");

      const payload = ok ? res.result : (res && res.error) || { message: "нет ответа" };
      ui.body.append(el("pre", "dsb-res-body", JSON.stringify(payload, null, 2)));

      if (!ok && res && res.error && res.error.code === "EAUTH") {
        ui.body.append(el("div", "dsb-res-hint", "Токен не задан или неверный — открой popup расширения и вставь токен из UI моста."));
      }

      const btn = el("button", "dsb-btn", "Вставить результат в чат");
      btn.addEventListener("click", () => {
        const okIns = insertIntoInput(resultText(call.tool, payload));
        addLog(okIns ? "результат вставлен в поле ввода" : "не нашёл поле ввода", okIns ? "ok" : "error");
      });
      ui.body.append(btn);

      // Результат с путём к картинке (screenshot) — прикрепляем файл к сообщению,
      // чтобы модель увидела пиксели, а не только метаданные.
      const produced = ok && res.result && typeof res.result.path === "string" ? res.result.path : null;
      if (produced && /\.(png|jpe?g|webp|gif|bmp)$/i.test(produced)) {
        images.push(produced);
        const attachBtn = el("button", "dsb-btn", "Прикрепить картинку в чат");
        attachBtn.addEventListener("click", () => attachImage(produced, "вручную"));
        ui.body.append(attachBtn);
      }

      summary.push({ tool: call.tool, ok, result: res && res.result, error: res && res.error });
    }

    // Вложения уходят вместе со следующим сообщением, поэтому их надо положить
    // в поле ввода ДО отправки.
    let attached = 0;
    if (state.autoAttach) {
      for (const path of images) {
        if (await attachImage(path, "авто")) attached++;
      }
    }

    if (!state.autoSend) return;

    const text =
      summary.length === 1
        ? resultText(summary[0].tool, summary[0].ok ? summary[0].result : summary[0].error)
        : "Результаты инструментов:\n\n```json\n" + JSON.stringify(summary, null, 2) + "\n```";

    await waitForGenerationEnd();
    await waitForSendSlot();

    if (insertIntoInput(text)) {
      // Ждём загрузку, только если что-то реально прикрепили. Признак —
      // кнопка отправки: она отключена, пока вложение не догрузилось. Без
      // вложений ждать нечего.
      if (attached) await waitForUploadReady();

      // Снимок «сколько раз на странице встречается текст лимита» до отправки:
      // иначе старое сообщение об ошибке примет новую удачную отправку за провал.
      const before = rateLimitHits();
      const sent = await submitInput();
      if (sent) sendGate.lastAt = Date.now();

      if (sent) {
        await sleep(1500);
        if (rateLimitHits() > before) noteRateLimit();
        else sendGate.strike = 0;
      }
      addLog(sent ? "результат отправлен автоматически" : "вставил, но кнопку отправки не нашёл", sent ? "ok" : "error");
    } else {
      addLog("не нашёл поле ввода для авто-отправки", "error");
    }
  }

  // ---------- прикрепление картинок в чат ----------
  // Ключевой момент: dsbridge-image показывает картинку ПОЛЬЗОВАТЕЛЮ, а модели
  // достаётся только путь к файлу. Чтобы модель реально видела пиксели, файл
  // надо прикрепить к сообщению — тогда DeepSeek загружает его и отдаёт модели
  // мультимодально.

  const attachedAt = new Map();
  const ATTACH_WINDOW_MS = 60000;

  function wasAttached(path) {
    const at = attachedAt.get(path);
    return at != null && Date.now() - at < ATTACH_WINDOW_MS;
  }

  function markAttached(path) {
    attachedAt.set(path, Date.now());
    for (const [key, at] of attachedAt) {
      if (Date.now() - at > ATTACH_WINDOW_MS) attachedAt.delete(key);
    }
  }

  function baseName(path) {
    const parts = String(path || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "image.png";
  }

  // data:URL -> File. Через atob, а не fetch(data:): CSP страницы может запрещать
  // data: в connect-src, и тогда fetch молча упадёт.
  function dataUrlToFile(dataUrl, name) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ""));
    if (!m) return null;
    const mime = m[1] || "application/octet-stream";
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return null;
    // Предпочитаем тот, что принимает картинки: у DeepSeek их может быть несколько
    // (вложение файла, картинка, аватар).
    const images = inputs.filter((i) => /image|\.png|\.jpe?g|\.webp/i.test(i.accept || ""));
    return images[0] || inputs[0];
  }

  // Куда бросать файл, если input[type=file] в DOM не оказалось. Кликать по кнопке
  // «прикрепить» нельзя: она открывает системный диалог выбора файла, который
  // перехватывает фокус и блокирует страницу.
  function dropTarget() {
    const ta = document.querySelector("textarea");
    if (!ta) return document.body;
    return ta.closest("form") || (ta.parentElement && ta.parentElement.parentElement) || ta;
  }

  // Основной путь: подсунуть File в скрытый input[type=file] и дёрнуть change —
  // для React-загрузчика это неотличимо от обычного выбора файла.
  function injectViaInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Запасной путь: часть загрузчиков слушает только drag&drop.
  function injectViaDrop(target, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }

  async function attachImage(path, why) {
    if (!path) return false;
    if (wasAttached(path)) {
      addLog("картинка уже прикреплена: " + path);
      return true;
    }

    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "raw", path });
    } catch {
      res = null;
    }
    if (!res || !res.ok || !res.dataUrl) {
      addLog("не прочитал картинку для прикрепления: " + path, "error");
      return false;
    }

    const file = dataUrlToFile(res.dataUrl, baseName(path));
    if (!file) {
      addLog("не разобрал data:URL для " + path, "error");
      return false;
    }

    const input = findFileInput();
    let how;
    if (input) {
      injectViaInput(input, file);
      how = "через input[type=file]";
    } else {
      injectViaDrop(dropTarget(), file);
      how = "через drag&drop";
    }

    markAttached(path);
    addLog("прикрепил " + file.name + " (" + Math.round(file.size / 1024) + " КБ, " + why + ", " + how + ")", "ok");
    return true;
  }

  // DeepSeek блокирует кнопку отправки, пока вложение загружается. Если отправить
  // раньше — уйдёт текст без картинки, и модель снова останется без зрения.
  //
  // Вызывать ТОЛЬКО когда текст уже в поле ввода: при пустом поле кнопка отправки
  // тоже отключена, и ожидание превратилось бы в гарантиенный таймаут.
  async function waitForUploadReady(maxMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      if (findSendButton()) return true;
      await sleep(300);
    }
    addLog("вложение всё ещё грузится — отправляю как есть", "error");
    return false;
  }

  // ---------- картинки и ссылки на файлы ----------

  async function fetchLocalImage(path) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "raw", path });
      return res && res.ok ? res.dataUrl : null;
    } catch {
      return null;
    }
  }

  async function renderImage(codeEl, spec) {
    const anchor = codeEl.closest("pre") || codeEl;
    const card = el("div", "dsb-image-card");
    const img = el("img", "dsb-image");
    img.alt = spec.alt || spec.src;
    img.loading = "lazy";

    const src = spec.src || "";
    const isRemote = /^https?:\/\//i.test(src);

    // CSP самой страницы может запретить внешние картинки — тогда показываем
    // не пустоту, а ссылку, по которой её можно открыть руками.
    const fallback = () => {
      img.style.display = "none";
      if (!card.querySelector(".dsb-img-open")) {
        const a = el("a", "dsb-img-open", "открыть картинку в новой вкладке ↗");
        a.href = src;
        a.target = "_blank";
        a.rel = "noreferrer";
        card.append(a);
      }
    };
    img.addEventListener("error", fallback);

    if (isRemote) {
      img.src = src;
    } else {
      const loading = el("div", "dsb-img-loading", "загружаю " + src + "…");
      card.append(loading);
      const dataUrl = await fetchLocalImage(src);
      loading.remove();
      if (dataUrl) img.src = dataUrl;
      else card.append(el("div", "dsb-res-hint", "не удалось прочитать картинку: " + src));
    }

    card.append(img);
    card.append(el("div", "dsb-img-caption", (spec.alt ? spec.alt + " — " : "") + src));
    anchor.after(card);
    anchor.style.display = "none";
  }

  function renderFileLink(codeEl, spec) {
    const anchor = codeEl.closest("pre") || codeEl;
    const card = el("div", "dsb-file-card");

    const open = el("a", "dsb-file-link", "📄 " + spec.label);
    open.href = "#";
    open.addEventListener("click", async (e) => {
      e.preventDefault();
      const res = await chrome.runtime.sendMessage({ type: "openFile", path: spec.path });
      addLog(res && res.ok ? "открыт файл: " + spec.path : "не удалось открыть: " + spec.path, res && res.ok ? "ok" : "error");
    });

    const dl = el("a", "dsb-file-dl", "скачать");
    dl.href = "#";
    dl.addEventListener("click", async (e) => {
      e.preventDefault();
      await chrome.runtime.sendMessage({ type: "openRaw", path: spec.path, download: true });
    });

    card.append(open, dl, el("span", "dsb-file-path", spec.path));
    anchor.after(card);
    anchor.style.display = "none";
  }

  // ---------- сканирование ----------

  function scan(manual = false) {
    const roots = reasoningRoots();
    const nodes = candidateNodes();
    state.scanned = nodes.length;
    let fresh = 0;

    nodes.forEach((node) => {
      // Уже обработан — второй раз не считаем и не трогаем.
      if (node.dataset.dsbDone === "1") return;

      const text = node.textContent.trim();
      if (!text.startsWith("{")) return;

      // Во время стриминга содержимое блока меняется на каждом кадре, поэтому
      // обрабатываем его только когда текст устоялся между двумя сканами.
      if (pending.get(node) !== text) {
        pending.set(node, text);
        return;
      }

      const spec = classify(node);
      if (!spec) return;

      if (inAny(node, roots)) {
        node.dataset.dsbDone = "1";
        state.skipped++;
        return;
      }

      const sig =
        spec.kind +
        "|" +
        (spec.kind === "tool" ? spec.tool + "|" + JSON.stringify(spec.args) : spec.src || spec.path);

      // Одинаковый вызов, повторённый в пределах пары секунд, — это перерисовка
      // DOM, а не новая команда. А вот тот же вызов через полминуты законен:
      // модель вполне может перечитать файл после правки, и раньше такой вызов
      // молча игнорировался навсегда.
      if (isDuplicate(sig)) {
        node.dataset.dsbDone = "1";
        return;
      }

      node.dataset.dsbDone = "1";
      fresh++;
      state.matched++;

      if (spec.kind === "tool") {
        if (state.auto) enqueue(spec, node);
        else {
          const ui = renderCallCard(node, spec);
          ui.stateEl.textContent = "не выполнено";
          const runBtn = el("button", "dsb-btn", "▶ Выполнить");
          runBtn.addEventListener("click", () => {
            runBtn.remove();
            queue.push({ call: spec, ui });
            clearTimeout(queueTimer);
            queueTimer = setTimeout(flushQueue, 50);
          });
          ui.body.append(runBtn);
        }
      } else if (spec.kind === "image") {
        renderImage(node, spec);
        // Модель просит показать картинку — заодно отдаём её и ей самой, иначе
        // она рассуждает о том, чего не видит. Только локальные файлы: внешний
        // URL может быть недоступен для загрузки.
        if (state.autoAttach && spec.src && !/^https?:\/\//i.test(spec.src)) {
          attachImage(spec.src, "по запросу модели");
        }
      } else if (spec.kind === "file") {
        renderFileLink(node, spec);
      }
    });

    setDiag(
      "блоков: " + state.scanned + " · обработано: " + state.matched + " · пропущено (размышление): " + state.skipped,
    );
    if (manual) addLog(fresh ? "новых блоков: " + fresh : "ничего не найдено", fresh ? "ok" : "info");
  }

  // ---------- поле ввода и отправка ----------

  function setNativeValue(node, value) {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(node, value);
  }

  function insertIntoInput(text) {
    const ta = document.querySelector("textarea");
    if (ta) {
      ta.focus();
      setNativeValue(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) {
      ce.focus();
      ce.textContent = text;
      ce.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  function findSendButton() {
    const ta = document.querySelector("textarea");
    const scope = (ta && (ta.closest("form") || (ta.parentElement && ta.parentElement.parentElement))) || document;
    const buttons = Array.from(scope.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-disabled") !== "true" && !b.disabled,
    );
    const iconOnly = buttons.filter((b) => b.querySelector("svg") && b.textContent.trim() === "");
    return iconOnly.length ? iconOnly[iconOnly.length - 1] : null;
  }

  async function submitInput() {
    await new Promise((r) => setTimeout(r, 200));
    const btn = findSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    const ta = document.querySelector("textarea");
    if (ta) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        ta.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }
      return true;
    }
    return false;
  }

  // ---------- старт ----------

  let lastScan = 0;
  function scanThrottled() {
    const now = Date.now();
    if (now - lastScan < 400) return;
    lastScan = now;
    scan(false);
  }

  buildPanel();
  loadSettings().then(applySettingsToPanel);
  pollHealth();
  setInterval(pollHealth, 5000);
  setInterval(scanThrottled, 1000);
  new MutationObserver(scanThrottled).observe(document.body, { childList: true, subtree: true });
  addLog("панель готова");
})();
