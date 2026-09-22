// Встраивается в веб-чат (DeepSeek, Qwen, ChatGPT, Claude, Gemini и др.):
//  - панель со статусом, диагностикой и логом,
//  - распознавание блоков ```dsbridge (вызов инструмента), ```dsbridge-file (ссылка
//    на файл), ```dsbridge-image (картинка) — блоки внутри «Размышления» игнорируются,
//  - исходный JSON красиво сворачивается, вместо него компактная карточка,
//  - несколько вызовов в одном сообщении выполняются по порядку и уходят одним ответом,
//  - скриншоты прикрепляются к сообщению как файл — тогда модель видит картинку,
//  - отправка идёт через шлюз с паузой, иначе чат отвечает «Слишком частые сообщения».
(() => {
  const PANEL_ID = "dsbridge-panel";
  // Панель живёт в собственном host-контейнере на <html>, а не в <body>: у чатов
  // на предке body часто висит transform, который превращает position:fixed в
  // position:absolute относительно этого предка — и панель «уплывает». Плюс
  // host с inset:0 не даёт overflow родителя обрезать её по краю экрана.
  const PANEL_HOST_ID = "dsbridge-host";
  const pending = new WeakMap();
  // Разбор блока по узлу: { text, spec }. Нужен, чтобы не парсить один и тот же
  // JSON на каждом проходе скана (нумерация блоков требует знать сигнатуру и у
  // уже обработанных узлов). Кэш сам себя сбрасывает, когда текст узла изменился.
  const specCache = new WeakMap();
  // Сигнатура вызова -> сколько раз его уже выполнили за эту сессию страницы.
  //
  // Счётчик, а не «выполнено/нет»: одинаковый вызов в одном сообщении может
  // встретиться дважды, и оба раза его надо выполнить. И счётчик, а не окно во
  // времени: чат перерисовывает старые сообщения при прокрутке вверх, узлы
  // создаются заново, метка data-dsbDone вместе с ними пропадает — и окно
  // в 5 секунд от повтора уже не спасало.
  const executedCount = new Map();
  const state = {
    auto: true,
    autoSend: true,
    autoAttach: true,
    sendIntervalSec: 4,
    // Позиция панели после перетаскивания. null — угол по умолчанию.
    panelPos: null,
    connected: false,
    scanned: 0,
    matched: 0,
    skipped: 0,
    // Сколько блоков оказались перерисовкой уже выполненного сообщения.
    repeated: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Версия расширения видна прямо в панели. Без неё по скриншоту невозможно
  // понять, свежая ли версия стоит в браузере, а половина «на этом сайте не
  // работает» лечится именно перезагрузкой расширения и вкладки.
  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "?";
    }
  }

  // ---------- сайты ----------
  //
  // Раньше скрипт был написан под один chat.deepseek.com. Теперь он ставится на
  // полтора десятка чатов, у каждого свой DOM, поэтому различия вынесены в реестр.
  //
  // Правило: в реестре — только то, что проверено или очевидно (имена хостов).
  // Всё остальное добирает общий путь: поле ввода ищется как textarea →
  // contenteditable → role=textbox, кнопка отправки — по aria-label, потом как
  // последняя кнопка-иконка рядом с полем. Поэтому новый сайт обычно достаточно
  // добавить в matches манифеста, а тонкую настройку — дописать сюда.
  //
  // Пустое поле означает «нет особого селектора, работает общий путь». Так честнее,
  // чем выдумывать селекторы: неверный селектор хуже отсутствующего — он ловит
  // не тот элемент и ломает отправку молча.
  //
  // Поля:
  //   id, name      — для панели и диагностики
  //   hosts         — подстроки хоста (совпадение по концу домена)
  //   input         — селекторы поля ввода
  //   send          — селекторы кнопки отправки
  //   fileInput     — селекторы input[type=file]
  //   drop          — куда бросать файл, если поля нет
  //   generating    — слова в aria-label/title кнопки «стоп» (признак генерации)
  //   reasoning     — подписи блока «размышлений», которые надо игнорировать
  //   rateLimit     — фразы лимита, которых нет в общем RATE_RE
  //
  // Про Arena: Battle Mode, Agent Mode, Side by Side и Direct — это режимы одного
  // интерфейса с общим композером, поэтому отдельных правил не требуют.

  const SITES = [
    {
      id: "deepseek",
      name: "DeepSeek",
      hosts: ["chat.deepseek.com"],
      // Своих фраз лимита нет: «Слишком частые сообщения» и «Повторите попытку
      // позже» уже в общем RATE_RE, дублировать их здесь — двойной счёт.
    },
    {
      id: "qwen",
      name: "Qwen",
      hosts: ["chat.qwen.ai"],
      // Снято с живой страницы 21.09.2026: поле — textarea.message-input-textarea.
      // Кнопки отправки в DOM нет, пока поле пустое: на её месте живёт кнопка
      // голосового режима (div.omb__btn), а button.send-button появляется после
      // ввода текста. Поэтому общий путь «последняя кнопка-иконка» тут опасен.
      input: ["textarea.message-input-textarea"],
      send: ["button.send-button", 'button[aria-label="Отправить"]'],
      fileInput: ["input#filesUpload"],
      rateLimit: ["请求过于频繁"],
    },
    {
      id: "arena",
      name: "Arena",
      hosts: ["arena.ai", "lmarena.ai"],
      send: ['button[type="submit"]'],
    },
    {
      id: "zai",
      name: "Z.ai",
      hosts: ["chat.z.ai"],
      // Снято с живой страницы 21.09.2026: поле — textarea#chat-input.
      // Кнопка button#send-message-button подписи не имеет вообще (ни aria-label,
      // ни title, ни текста), поэтому ловится только по id.
      input: ["textarea#chat-input"],
      send: ["button#send-message-button"],
      rateLimit: ["请求过于频繁"],
    },
    {
      id: "kimi",
      name: "Kimi",
      hosts: ["kimi.com"],
      input: [".chat-input-editor", '[contenteditable="true"]'],
      rateLimit: ["请求过于频繁"],
    },
    {
      id: "aistudio",
      name: "AI Studio",
      hosts: ["aistudio.google.com"],
      // Снято с живой страницы 21.09.2026: поле — textarea.prompt-builder__input.
      // Кнопки Run в композере нет, пока поле пустое, зато по всей странице полно
      // чужих кнопок-иконок (карусели «Next slide») — общий путь тут промахивался.
      input: ["textarea.prompt-builder__input"],
      send: ['button[aria-label="Run"]', 'button[aria-label="Отправить"]'],
      rateLimit: ["You've reached your limit"],
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      input: ["#prompt-textarea", ".ProseMirror"],
      send: ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]'],
      generating: ["stop"],
      rateLimit: ["making requests too quickly"],
    },
    {
      id: "gemini",
      name: "Gemini",
      hosts: ["gemini.google.com"],
      input: ["rich-textarea .ql-editor", ".ql-editor"],
      send: ['.send-button', 'button[aria-label="Send message"]'],
      generating: ["stop response"],
      rateLimit: ["reached your limit"],
    },
    {
      id: "claude",
      name: "Claude",
      hosts: ["claude.ai"],
      input: [".ProseMirror", '[contenteditable="true"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
      generating: ["stop response"],
      rateLimit: ["message limit reached", "out of free messages"],
    },
    {
      id: "copilot",
      name: "Copilot",
      hosts: ["copilot.microsoft.com"],
      input: ["textarea#userInput", "textarea"],
      send: ['button[title="Submit message"]', 'button[aria-label="Submit message"]'],
      rateLimit: ["reached the limit"],
    },
    {
      id: "mistral",
      name: "Le Chat",
      hosts: ["chat.mistral.ai"],
      send: ['button[type="submit"]'],
      rateLimit: ["reached your limit"],
    },
    {
      id: "grok",
      name: "Grok",
      hosts: ["grok.com"],
      send: ['button[type="submit"]', 'button[aria-label="Submit"]'],
      generating: ["stop"],
      rateLimit: ["reached your limit"],
    },
    {
      id: "minimax",
      name: "MiniMax Agent",
      hosts: ["agent.minimax.io"],
      // Снято с живой страницы 21.09.2026: поле — div.tiptap.ProseMirror
      // (contenteditable, не textarea), а кнопка отправки — не <button>, а
      // div[role=button][data-testid="send-button"] с aria-label "Send message".
      // Общий путь цеплял вместо неё кнопку бокового меню.
      input: [".tiptap.ProseMirror", ".ProseMirror", '[contenteditable="true"]'],
      send: ['[data-testid="send-button"]', '[aria-label="Send message"]'],
      fileInput: ['[data-testid="attach-button"] input[type="file"]', 'input[type="file"]'],
    },
    {
      id: "huggingface",
      name: "HF Chat",
      hosts: ["huggingface.co"],
      send: ['button[type="submit"]'],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      hosts: ["openrouter.ai"],
      send: ['button[type="submit"]'],
    },
    // Последний в списке — общий: ловит всё, что не описано выше, и работает на
    // любом сайте, добавленном в манифест позже.
    { id: "generic", name: "Чат", hosts: [] },
  ];

  function detectSite(hostname) {
    const host = String(hostname || "").toLowerCase();
    for (const s of SITES) {
      for (const h of s.hosts) {
        if (host === h || host.endsWith("." + h)) return s;
      }
    }
    return SITES[SITES.length - 1];
  }

  const site = detectSite(location.hostname);

  // Первый подходящий элемент из списка селекторов. Битая строка селектора не
  // должна ронять скрипт — она просто пропускается.
  function queryFirst(selectors, root) {
    const scope = root || document;
    for (const sel of selectors || []) {
      let node = null;
      try {
        node = scope.querySelector(sel);
      } catch {
        node = null;
      }
      if (node) return node;
    }
    return null;
  }

  function isClickable(node) {
    if (!node) return false;
    if (node.disabled) return false;
    return node.getAttribute("aria-disabled") !== "true";
  }

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
      const pos = saved.panelPos;
      if (pos && Number.isFinite(Number(pos.left)) && Number.isFinite(Number(pos.top))) {
        state.panelPos = { left: Math.round(Number(pos.left)), top: Math.round(Number(pos.top)) };
      }
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
          panelPos: state.panelPos,
        },
      });
    } catch {
      // не критично: настройки просто не переживут перезагрузку
    }
  }

  // ---------- тормоз отправки ----------
  // Чаты отвечают «Слишком частые сообщения. Повторите попытку позже», если писать
  // слишком часто. Поэтому отправка идёт через шлюз: минимальный интервал
  // между сообщениями плюс штрафная пауза, если лимит всё-таки поймали.

  const sendGate = { lastAt: 0, penaltyUntil: 0, strike: 0 };
  const RATE_RE = /Слишком частые сообщения|Повторите попытку позже|Too many requests|rate limit/gi;

  // Считаем вхождения, а не «есть/нет»: сообщение об ошибке может висеть в чате
  // с прошлой попытки, и тогда сравнение «до/после» ловит именно новое.
  //
  // Кроме общего RATE_RE учитываем фразы конкретного сайта: формулировки у всех
  // разные, а общий шаблон не должен ловить лишнее (ложный лимит — это штрафная
  // пауза до двух минут на ровном месте).
  function siteRatePatterns() {
    const out = [];
    for (const src of (site && Array.isArray(site.rateLimit) ? site.rateLimit : [])) {
      try {
        out.push(new RegExp(src, "gi"));
      } catch {
        // битая фраза не должна ломать подсчёт лимита
      }
    }
    return out;
  }

  function rateLimitHits() {
    const text = document.body.innerText || "";
    let n = 0;
    for (const re of [RATE_RE].concat(siteRatePatterns())) {
      re.lastIndex = 0;
      while (re.exec(text) !== null) n++;
    }
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
      setGateHint("лимит чата — пауза " + left + " с");
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
      "поймал лимит чата — пауза " + Math.round(wait / 1000) + " с (штраф №" + sendGate.strike + ")",
      "error",
    );
  }

  // Пока модель отвечает, чат держит на месте кнопки отправки кнопку «стоп».
  // Клик по ней оборвал бы ответ вместо отправки, поэтому ждём конца генерации.
  //
  // Признак намеренно узкий — только метка кнопки. Угадывать по форме иконки
  // опасно: ложное срабатывание заставило бы ждать на каждой отправке.
  const GENERATING_LABELS = ["stop", "останов", "стоп", "中止", "停止"];

  function isGenerating() {
    const words = GENERATING_LABELS.concat(site && Array.isArray(site.generating) ? site.generating : []);
    const re = new RegExp(words.join("|"), "i");
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.some((b) =>
      re.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")),
    );
  }

  async function waitForGenerationEnd(maxMs = 20000) {
    const started = Date.now();
    let announced = false;
    while (Date.now() - started < maxMs) {
      if (!isGenerating()) return true;
      if (!announced) {
        setGateHint("ждём, пока модель договорит");
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
    "  вместо пяти, и лимит частоты у чата не так быстро кончается.",
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
  ].join("\n");

  // Заголовок списка инструментов — отдельной константой: между ним и самим списком
  // вставляется память проекта, а заголовок, оторванный от своего списка, путает.
  // Объявление в одну строку: тесты и превью вычитывают константы регуляркой.
  const INSTRUCTION_TOOLS_HEADER = "ИНСТРУМЕНТЫ (список собран из реестра моста; в фигурных скобках — имена аргументов)";

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

  // ---------- память проекта ----------
  //
  // Файл памяти лежит в КОРНЕ рабочей папки, поэтому у каждой папки (проекта) своя
  // память, а не одна общая. Так просил пользователь: «чтобы ии записывал всё нужное
  // в MEMORY.md для каждого отдельного проекта».
  //
  // Содержимое подставляется прямо в инструкцию: модель получает контекст проекта
  // сразу, без отдельного хода на чтение. Файла нет — не выдумываем, а честно
  // помечаем это в тексте.

  const MEMORY_FILE = "MEMORY.md";
  const MEMORY_INJECT_LIMIT = 4000;
  // Что вышло с памятью в прошлый сборке инструкции — показываем в панели,
  // иначе непонятно, подставилась она или файла нет.
  let projectMemoryState = "не прочитана";

  const INSTRUCTION_MEMORY = [
    "ПАМЯТЬ ПРОЕКТА — ОБЯЗАТЕЛЬНО",
    "У каждой рабочей папки своя память: файл MEMORY.md в её корне. Это память именно этого",
    "проекта, а не общая на все чаты.",
    "1. ПЕРЕД работой: прочитай MEMORY.md (read_file). Он подставлен выше — но если работа",
    "   длинная, перечитай: файл мог измениться.",
    "2. ПОСЛЕ существенной работы: допиши в MEMORY.md то, что пригодится в следующий раз —",
    "   что за проект, команды запуска и тестов, конвенции, принятые решения, грабли, открытые",
    "   хвосты. Дописывай через edit_file или write_file { mode: \"append\" }.",
    "3. Это сводка, а не свалка: короткие разделы, факты, команды, причины. Без пересказа",
    "   переписки. Файл разросся — перепиши его сжато.",
    "4. Пиши только то, что переживёт сессию. Промежуточные логи и разовые результаты — нет.",
    "5. Не создавай MEMORY.md, если записывать нечего.",
  ].join("\n");

  // Содержимое файла памяти рабочей папки. null — файла нет или прочитать не удалось
  // (например, мост молчит); это разные вещи, поэтому и подпись разная.
  async function readProjectMemory() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "tool",
        tool: "read_file",
        args: { path: MEMORY_FILE },
      });
      if (res && res.ok && res.result && typeof res.result.content === "string") {
        return res.result.content;
      }
      if (res && res.error && res.error.code === "ENOENT") return "";
    } catch {
      // мост недоступен — считаем, что памяти нет
    }
    return null;
  }

  function memoryBlock(content) {
    const head = "ПАМЯТЬ ЭТОГО ПРОЕКТА (" + MEMORY_FILE + ", подставлено автоматически)";
    if (content == null) {
      return head + "\n(не прочитал файл: мост не ответил. Проверь связь и перечитай " + MEMORY_FILE + " сам.)";
    }
    if (!content.trim()) {
      return head + "\n(файла нет или он пуст — создай, когда появится что записать.)";
    }
    const cut = content.length > MEMORY_INJECT_LIMIT;
    const body = cut ? content.slice(0, MEMORY_INJECT_LIMIT) : content;
    return head + "\n" + body + (cut ? "\n…(обрезано, полностью — через read_file " + MEMORY_FILE + ")" : "");
  }

  // Зелёная строка в логе только когда память реально подставилась.
  function memoryHintLevel() {
    return projectMemoryState.startsWith(MEMORY_FILE + " —") ? "ok" : "info";
  }

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
    "Разделяй две памяти: MEMORY.md в рабочей папке — долговременные знания о ПРОЕКТЕ (его",
    "видит и человек, он живёт вместе с папкой); remember — быстрая заметка в данных моста,",
    "когда нужно просто не потерять мелочь между чатами.",
    "",
    "ПРО .trash",
    "delete не удаляет безвозвратно, а переносит в <workspace>/.trash/. Вернуть файл:",
    "move { from: \".trash/1234567_file.txt\", to: \"file.txt\" }.",
    "",
    "ТОНКОСТИ, КОТОРЫЕ ЭКОНОМЯТ ХОДЫ",
    "- Файлы могут меняться во время сессии (идёт сборка, работает другой процесс). Если grep",
    "  не находит то, что должно быть, — перечитай файл, прежде чем делать вывод.",
    "- read_file сам определяет кодировку (cp1251/cp866/UTF-8) и в ответе отдаёт encoding и",
    "  detectedEncoding. encoding: \"auto\" — тот же режим явно; можно указать конкретную.",
    "- На Windows пайп в run_command (| findstr) часто даёт пустой stdout: пиши вывод в файл",
    "  (`... > build.log 2>&1`) и читай его через read_file. env — объект, %VAR% не раскрывается.",
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
  // не осталась совсем без карты инструментов. Память проекта читаем тем же ходом:
  // два независимых запроса — незачем ждать их по очереди.
  async function buildInstruction() {
    const [toolsRes, memory] = await Promise.all([
      chrome.runtime.sendMessage({ type: "tools" }).catch(() => null),
      readProjectMemory(),
    ]);

    let tools = null;
    if (toolsRes && toolsRes.ok && Array.isArray(toolsRes.tools)) tools = toolsRes.tools;

    projectMemoryState =
      memory == null
        ? "мост не ответил"
        : memory.trim()
          ? MEMORY_FILE + " — " + memory.length + " символов"
          : MEMORY_FILE + " нет";

    const list = buildToolList(tools);
    const body = list
      ? list
      : "(мост не ответил — подробный список недоступен; имена инструментов: " +
        FALLBACK_TOOL_NAMES.join(", ") +
        ")\n";
    return (
      INSTRUCTION_INTRO +
      "\n" +
      memoryBlock(memory) +
      "\n\n" +
      INSTRUCTION_MEMORY +
      "\n\n" +
      INSTRUCTION_TOOLS_HEADER +
      "\n\n" +
      body +
      "\n" +
      INSTRUCTION_OUTRO
    );
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- перенос панели ----------
  // Панель стоит в правом нижнем углу, а на половине чатов там же композер.
  // Поэтому её можно утащить за заголовок; позиция запоминается в настройках.

  function applyPanelPos() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state.panelPos) return;
    panel.style.left = state.panelPos.left + "px";
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function makePanelDraggable(panel) {
    const head = panel.querySelector(".dsb-head");
    let grabX = 0;
    let grabY = 0;
    let dragging = false;

    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // по кнопке «свернуть» не тащим
      const rect = panel.getBoundingClientRect();
      dragging = true;
      grabX = e.clientX - rect.left;
      grabY = e.clientY - rect.top;
      head.style.cursor = "grabbing";
      try {
        head.setPointerCapture(e.pointerId);
      } catch {
        // без захвата указателя перетаскивание всё равно работает, просто рвётся
        // при выходе курсора за панель
      }
    });

    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      // Панель не должна уехать за край: вернуть её оттуда нечем.
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - 40);
      const left = Math.min(Math.max(0, e.clientX - grabX), maxLeft);
      const top = Math.min(Math.max(0, e.clientY - grabY), maxTop);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      head.style.cursor = "";
      const rect = panel.getBoundingClientRect();
      state.panelPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      saveSettings();
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  // ---------- панель ----------

  // Host-контейнер панели. all:initial снимает унаследованные стили чата,
  // position:fixed + inset:0 — оверлей на весь экран, не зависящий от разметки
  // страницы; pointer-events:none пропускает клики мимо панели.
  function panelHost() {
    let host = document.getElementById(PANEL_HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = PANEL_HOST_ID;
    host.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;";
    document.documentElement.appendChild(host);
    return host;
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = el("div");
    panel.id = PANEL_ID;
    panel.innerHTML = [
      '<div class="dsb-head" id="dsb-head" title="Потяни, чтобы перенести панель">',
      '  <span class="dsb-dot" id="dsb-dot"></span>',
      '  <span class="dsb-title">Дипсик Мост</span>',
      '  <span class="dsb-site" id="dsb-site">' + site.name + " · v" + extensionVersion() + "</span>",
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
    panelHost().appendChild(panel);
    makePanelDraggable(panel);
    applyPanelPos();

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
      addLog("память проекта: " + projectMemoryState, memoryHintLevel());
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
  //
  // Блоки внутри «размышлений» выполнять нельзя: модель часто пишет там пример
  // вызова, а не сам вызов. Подписи у чатов разные, поэтому список общий плюс
  // добавка из реестра сайтов.

  const REASONING_LABELS = [
    "Размышление", "Размышляю", "Рассуждения", "Reasoning", "Thinking", "Thoughts",
    "思考", "思考过程", "已思考",
  ];

  function reasoningLabelRe() {
    const words = REASONING_LABELS.concat(site && Array.isArray(site.reasoning) ? site.reasoning : []);
    return new RegExp("^(" + words.join("|") + ")", "i");
  }

  let rootsCache = { at: 0, set: new Set() };

  function reasoningRoots() {
    const now = Date.now();
    if (now - rootsCache.at < 1500) return rootsCache.set;

    const roots = new Set();
    document.querySelectorAll("[class]").forEach((node) => {
      const cls = typeof node.className === "string" ? node.className : "";
      if (cls && /think|reason|thought|размышл|cot/i.test(cls)) roots.add(node);
    });
    const re = reasoningLabelRe();
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

  // Достать JSON-объект из текста блока.
  //
  // Раньше требовалось, чтобы ВЕСЬ текст блока был JSON — этого хватало, пока
  // разметка была простой. У Qwen и Z.ai в контейнер блока попадает ещё подпись
  // языка и кнопка «копировать», и строгий разбор такой блок молча пропускал:
  // снаружи это выглядит как «модель не отвечает блоками».
  //
  // Поэтому берём первую «{» и идём до парной закрывающей скобки, честно
  // отслеживая строки и экранирование — иначе `}` внутри строки оборвал бы
  // объект на середине. Разбор сбалансированной скобки заодно не даёт вытащить
  // JSON из блока, где он лишь упомянут в тексте.
  function jsonFromText(text) {
    const src = normalize(text);
    const start = src.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const json = JSON.parse(src.slice(start, i + 1));
            return json && typeof json === "object" ? json : null;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function classify(codeEl) {
    const cls = typeof codeEl.className === "string" ? codeEl.className : "";
    const parentCls = codeEl.parentElement && typeof codeEl.parentElement.className === "string" ? codeEl.parentElement.className : "";
    const label = cls + " " + parentCls;
    if (/result/i.test(label)) return null;

    const json = jsonFromText(codeEl.textContent);
    if (!json) return null;

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

  // Устойчивая сериализация: порядок ключей в JSON от модели может меняться
  // (`{"tool":…,"args":…}` и `{"args":…,"tool":…}` — один и тот же вызов), а
  // обычный JSON.stringify даёт разные строки и превратил бы один вызов в два.
  function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(value);
  }

  // Сигнатура вызова: по ней отличаем повтор от новой команды. Аргументы входят
  // целиком — «прочитать другой файл» это уже другая команда.
  //
  // Второй аргумент (node) не используется: попытка учесть «контекст сообщения»
  // ломала счётчик — в текст контейнера попадали наши же карточки результатов,
  // отпечаток менялся от прохода к проходу, и перерисовка переставала опознаваться.
  // Оставлен в подписи, чтобы не трогать вызовы.
  function signatureOf(spec, node) {
    void node;
    const base =
      spec.kind +
      "|" +
      (spec.kind === "tool" ? spec.tool + "|" + stableJson(spec.args) : spec.src || spec.path);
    return base;
  }

  // Защита от повторного выполнения одного и того же блока.
  //
  // Чат перерисовывает старые сообщения при прокрутке вверх: узлы создаются
  // заново, и метка data-dsbDone вместе с ними пропадает. Раньше от повтора
  // спасало окно в 5 секунд, поэтому через минуту прокрутка запускала старые
  // команды заново — вплоть до write_file и delete.
  //
  // Теперь помним, сколько раз каждый вызов уже выполнен, и сравниваем с тем,
  // который по счёту этот блок в текущем DOM. N-й блок с такой сигнатурой
  // выполняется, только если предыдущие N−1 уже были выполнены: перерисовка
  // даёт тот же счётчик и повтор не проходит, а новое сообщение с тем же вызовом
  // даёт счётчик на единицу больше и выполняется.
  function isRepeat(sig, n) {
    return n <= (executedCount.get(sig) || 0);
  }

  function candidateNodes() {
    const out = [];
    const push = (node) => {
      if (!node || out.includes(node)) return;
      if (node.closest("#" + PANEL_ID + ", .dsb-result, .dsb-image-card, .dsb-file-card")) return;
      // Один блок не должен попадать в список дважды — как <pre> и его <code>
      // или как контейнер и его внутренности. Раньше от двойного выполнения
      // спасало только окно дедупликации в 5 секунд, и один вызов выполнялся
      // по два-три раза подряд.
      for (const seen of out) if (seen.contains(node)) return;
      out.push(node);
    };
    // Сначала <code>: он лежит внутри <pre> и несёт класс языка
    // (language-dsbridge), который нужен classify. Если взять <pre>, класс
    // языка потеряется — а <code> всё равно даёт доступ к классу родителя.
    document.querySelectorAll("code").forEach(push);
    document.querySelectorAll("pre").forEach((node) => {
      if (node.querySelector("code")) return;
      push(node);
    });
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

  // Диагностика адаптера: что нашлось на живом сайте. Нужна, чтобы проверять
  // селекторы на настоящих чатах, а не догадываться по коду.
  function describeNode(node) {
    if (!node) return "нет";
    const id = node.id ? "#" + node.id : "";
    const cls =
      typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return node.tagName.toLowerCase() + id + cls;
  }

  function siteReport() {
    const send = findSendButton(true);
    return [
      "сайт: " + site.name + " (" + site.id + ") · расширение v" + extensionVersion(),
      "поле ввода: " + describeNode(findInput()),
      "кнопка отправки: " + describeNode(send) + (send && !isClickable(send) ? " — сейчас выключена" : ""),
      "поле загрузки файла: " + describeNode(findFileInput()),
    ];
  }

  function dumpDom() {
    for (const line of siteReport()) addLog(line);
    const nodes = candidateNodes();
    const withJson = nodes.filter((n) => jsonFromText(n.textContent));
    const withWord = nodes.filter(
      (n) =>
        /dsbridge/i.test(n.textContent) ||
        /dsbridge/i.test(typeof n.className === "string" ? n.className : ""),
    );
    const runnable = nodes.filter((n) => classify(n));
    addLog("блоков кода на странице: " + nodes.length + " · с JSON: " + withJson.length + " · распознано вызовов: " + runnable.length);
    // Разделение важное: «dsbridge упомянут, но не разобран» — это баг разбора
    // разметки, а «упоминаний нет вовсе» — модель не вывела блок.
    addLog("упоминаний dsbridge в блоках: " + withWord.length + (withWord.length && !runnable.length ? " — блок есть, но не разобран" : ""));
    nodes.slice(0, 6).forEach((n, i) => {
      const head = n.textContent.trim().replace(/\s+/g, " ").slice(0, 70);
      addLog("#" + (i + 1) + " " + chainOf(n) + " :: " + head);
    });
  }

  // ---------- карточка вызова ----------

  function hideRawBlock(codeEl) {
    const block = codeEl.closest("pre") || codeEl;
    block.style.display = "none";
    return block;
  }

  // Перерисованное старое сообщение: вызов в этом чате уже выполнялся. Рисуем
  // пометку вместо карточки с кнопкой — иначе при прокрутке вверх в чате снова
  // оказывался сырой JSON, а команда выполнялась второй раз.
  //
  // Кнопка «выполнить всё равно» — на случай, когда повтор был законным: модель
  // действительно просит перечитать файл после правки. Отличить это от
  // перерисовки по DOM нельзя (виртуализация ленты стирает старые сообщения),
  // поэтому выбор отдаём человеку.
  function renderRepeatCard(codeEl, spec, n) {
    const anchor = codeEl.closest("pre") || codeEl;
    const what = spec.kind === "tool" ? spec.tool : spec.kind === "image" ? "картинка" : "файл";
    const card = el("div", "dsb-repeat");
    card.append(el("span", "dsb-repeat-mark", "↺"));
    card.append(
      el(
        "span",
        "dsb-repeat-text",
        "вызов " + what + " уже выполнен в этом чате" + (n > 1 ? " (" + n + "-й раз)" : "") + " — повтор пропущен",
      ),
    );

    if (spec.kind === "tool") {
      const again = el("button", "dsb-mini", "выполнить всё равно");
      again.addEventListener("click", () => {
        again.remove();
        // Счётчик поднимаем, иначе следующий проход снова сочтёт блок повтором.
        const repSig = signatureOf(spec, codeEl);
        executedCount.set(repSig, (executedCount.get(repSig) || 0) + 1);
        const ui = renderCallCard(codeEl, spec);
        queue.push({ call: spec, ui });
        clearTimeout(queueTimer);
        queueTimer = setTimeout(flushQueue, 50);
        addLog("повтор " + spec.tool + " запущен вручную");
      });
      card.append(again);
    }

    anchor.after(card);
    anchor.style.display = "none";
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

  // Очередь выполнялась одной функцией, но защита от повторного входа
  // отсутствовала: пока await callTool ждал мост, следующий скан успевал
  // запустить flushQueue второй раз — и два вызова шли параллельно. На git это
  // выглядело как гонка: `add` и `commit` уходили одновременно, и commit
  // отвечал «nothing to commit». Теперь в полёте ровно один прогон; если во
  // время него пришли новые вызовы — крутимся ещё раз.
  let flushing = false;
  let flushPending = false;

  async function flushQueue() {
    if (flushing) {
      flushPending = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushPending = false;
        await flushQueueInner();
      } while (flushPending || queue.length);
    } finally {
      flushing = false;
    }
  }

  async function flushQueueInner() {
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
  // надо прикрепить к сообщению — тогда чат загружает его и отдаёт модели
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
    const specific = queryFirst(site && site.fileInput ? site.fileInput : []);
    if (specific) return specific;
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return null;
    // Предпочитаем тот, что принимает картинки: у чата их может быть несколько
    // (вложение файла, картинка, аватар).
    const images = inputs.filter((i) => /image|\.png|\.jpe?g|\.webp/i.test(i.accept || ""));
    return images[0] || inputs[0];
  }

  // Куда бросать файл, если input[type=file] в DOM не оказалось. Кликать по кнопке
  // «прикрепить» нельзя: она открывает системный диалог выбора файла, который
  // перехватывает фокус и блокирует страницу.
  function dropTarget() {
    const specific = queryFirst(site && site.drop ? site.drop : []);
    if (specific) return specific;
    const node = findInput();
    if (!node) return document.body;
    return node.closest("form") || (node.parentElement && node.parentElement.parentElement) || node;
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

  // Чат блокирует кнопку отправки, пока вложение загружается. Если отправить
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
    // Какой по счёту блок с такой сигнатурой мы видим в этом проходе. Нужен,
    // чтобы отличить перерисовку старого сообщения (тот же счётчик) от нового
    // сообщения с тем же вызовом (счётчик на единицу больше).
    const seenInScan = new Map();

    nodes.forEach((node) => {
      const text = node.textContent.trim();
      // Дешёвая отсечка: без «{» разбирать нечего. Именно includes, а не
      // startsWith — перед JSON в блоке бывает подпись языка (Qwen, Z.ai).
      if (!text.includes("{")) return;

      // Разбор кэшируем по тексту узла: во время стриминга текст меняется, и
      // кэш сам себя инвалидирует, а на устоявшемся блоке JSON не парсится
      // заново на каждом проходе.
      const cached = specCache.get(node);
      let spec;
      if (cached && cached.text === text) spec = cached.spec;
      else {
        spec = classify(node);
        specCache.set(node, { text, spec });
      }
      if (!spec) return;

      const sig = signatureOf(spec, node);

      // Нумерацию ведём ДО проверки метки: уже выполненный блок тоже занимает
      // своё место в ленте. Иначе он не попадёт в счёт, и новый блок с тем же
      // вызовом получит номер 1 вместо 2 — и его примут за повтор.
      const n = (seenInScan.get(sig) || 0) + 1;
      seenInScan.set(sig, n);

      // Уже обработан — не трогаем (номер уже учли выше).
      if (node.dataset.dsbDone === "1") return;

      // Во время стриминга содержимое блока меняется на каждом кадре, поэтому
      // обрабатываем его только когда текст устоялся между двумя сканами.
      if (pending.get(node) !== text) {
        pending.set(node, text);
        return;
      }

      if (inAny(node, roots)) {
        node.dataset.dsbDone = "1";
        state.skipped++;
        return;
      }

      // Такой вызов в этом чате уже выполнялся (столько-то раз) — это перерисовка
      // старого сообщения, а не новая команда. Раньше здесь было окно в 5 секунд,
      // и через минуту прокрутка запускала старые команды заново.
      if (isRepeat(sig, n)) {
        node.dataset.dsbDone = "1";
        renderRepeatCard(node, spec, n);
        state.repeated++;
        return;
      }
      executedCount.set(sig, n);

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
      site.name +
        " · блоков: " + state.scanned +
        " · обработано: " + state.matched +
        " · повторов: " + state.repeated +
        " · пропущено (размышление): " + state.skipped,
    );
    if (manual) addLog(fresh ? "новых блоков: " + fresh : "ничего не найдено", fresh ? "ok" : "info");
  }

  // ---------- поле ввода и отправка ----------
  //
  // Поле бывает трёх видов: textarea, input и contenteditable (ProseMirror у
  // ChatGPT и Claude, Quill у Gemini, свои редакторы у остальных). Ищем по
  // порядку: селекторы сайта → textarea → contenteditable → role=textbox.

  function findInput() {
    const specific = queryFirst(site && site.input ? site.input : []);
    if (specific) return specific;
    return (
      document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('[role="textbox"]')
    );
  }

  // Композер — ближайший общий контейнер поля и кнопки отправки. По нему
  // ограничиваем поиск кнопок, чтобы не нажать чужую кнопку на странице.
  function composerScope(input) {
    if (!input) return document;
    return input.closest("form") || (input.parentElement && input.parentElement.parentElement) || document;
  }

  function setNativeValue(node, value) {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(node, value);
  }

  // contenteditable: прямое присваивание textContent редакторы на React
  // (ProseMirror, Lexical, Quill) не замечают — своё состояние они обновляют
  // только по настоящему вводу. Поэтому выделяем всё и вставляем командой
  // insertText: она идёт через ввод, и редактор видит текст как свой.
  function insertIntoEditable(node, text) {
    node.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand("insertText", false, text)) {
        node.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    } catch {
      // execCommand может быть недоступен — ниже присваивание как запасной путь
    }
    node.textContent = text;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }

  function insertIntoInput(text) {
    const node = findInput();
    if (!node) return false;
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      setNativeValue(node, text);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return insertIntoEditable(node, text);
  }

  // Явные метки кнопки отправки: одинаковы у большинства чатов и не зависят от
  // языка интерфейса. Проверяются после селекторов сайта.
  //
  // Тег намеренно не указан: у части чатов отправка — не <button>, а div с
  // role=button (MiniMax: div[data-testid="send-button"]). Элемент с таким
  // testid или с подписью «Send message» — это отправка по определению, чем бы
  // он ни был в разметке. Исключение — type=submit: он бывает только у кнопки.
  const SEND_SELECTORS = [
    '[data-testid="send-button"]',
    '[data-testid="composer-submit-button"]',
    '[aria-label="Send message"]',
    '[aria-label="Send Message"]',
    '[aria-label="Отправить"]',
    'button[type="submit"]',
  ];
  const SEND_LABEL_RE = /send|submit|отправ|промпт|prompt|ask|run|送信|发送|生成/i;

  function labelOf(node) {
    return (node.getAttribute("aria-label") || "") + " " + (node.getAttribute("title") || "");
  }

  // Кандидаты в кнопку отправки, по убыванию надёжности. Отдельной функцией —
  // чтобы диагностика могла показать кнопку даже выключенной: при пустом поле
  // она всегда disabled, и по одному «нет» невозможно понять, дело в селекторе
  // или в состоянии.
  //
  // Поля ввода нет — кандидатов нет вовсе: без него отправлять всё равно нечего,
  // а «последняя кнопка на странице» — это уже не отправка, а лотерея.
  // Зазор между кнопкой и полем ввода: 0, если прямоугольники пересекаются.
  // Мера «рядом», устойчивая к тому, что композер бывает и строкой, и колонкой.
  function gapToInput(node) {
    const input = findInput();
    if (!input) return 0;
    const a = node.getBoundingClientRect();
    const b = input.getBoundingClientRect();
    const dx = Math.max(b.left - a.right, a.left - b.right, 0);
    const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
    return Math.hypot(dx, dy);
  }

  // Насколько далеко от поля может стоять кнопка отправки. 240 px с запасом
  // хватает на «поле + панель инструментов + кнопка», но отсекает боковое меню
  // и карусели в другом конце страницы.
  const ICON_NEAR_PX = 240;

  function sendCandidates() {
    const input = findInput();
    if (!input) return [];
    const scope = composerScope(input);
    const selectors = (site && site.send ? site.send : []).concat(SEND_SELECTORS);
    const out = [];

    const add = (node) => {
      if (node && !out.includes(node)) out.push(node);
    };

    // 1. Явные селекторы внутри композера, 2. кнопка с подходящей меткой,
    // 3. последняя кнопка-иконка рядом с полем (у DeepSeek их две: «прикрепить»
    // и «отправить»), 4. то же самое по всей странице — если композер
    // определился неверно.
    for (const root of [scope, document]) {
      for (const sel of selectors) {
        try {
          add(root.querySelector(sel));
        } catch {
          // битый селектор просто пропускаем
        }
      }
      const buttons = Array.from(root.querySelectorAll("button"));
      for (const b of buttons) if (SEND_LABEL_RE.test(labelOf(b))) add(b);
      // Иконка без подписи сама по себе ничего не доказывает: таких кнопок на
      // странице десятки (меню, карусели, «закрыть»). Кнопка отправки всегда
      // стоит рядом с полем ввода, поэтому берём только ближние. Ничего рядом —
      // лучше не нажать ничего, чем нажать что попало.
      const iconOnly = buttons.filter((b) => b.querySelector("svg") && b.textContent.trim() === "");
      const near = iconOnly.filter((b) => gapToInput(b) <= ICON_NEAR_PX);
      if (near.length) add(near[near.length - 1]);
    }
    return out;
  }

  function findSendButton(includeDisabled = false) {
    for (const node of sendCandidates()) {
      if (includeDisabled || isClickable(node)) return node;
    }
    return null;
  }

  async function submitInput() {
    await new Promise((r) => setTimeout(r, 200));
    const btn = findSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    const node = findInput();
    if (node) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        node.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
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
  // Позицию панели применяем после чтения настроек: до этого она ещё неизвестна.
  loadSettings().then(() => {
    applySettingsToPanel();
    applyPanelPos();
  });
  pollHealth();
  setInterval(pollHealth, 5000);
  setInterval(scanThrottled, 1000);
  new MutationObserver(scanThrottled).observe(document.body, { childList: true, subtree: true });
  addLog("панель готова · сайт: " + site.name + " · расширение v" + extensionVersion());
})();
