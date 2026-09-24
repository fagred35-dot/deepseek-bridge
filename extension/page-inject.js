// Перехватчик сетевых запросов страницы — живёт в MAIN world (мир самой страницы).
//
// Зачем: скрытый системный промпт. Пользователь задаёт свой текст в настройках
// расширения, и он уходит модели в каждом запросе, но НЕ появляется в видимом чате.
//
// Как: подменяем window.fetch и XMLHttpRequest. Для POST-запросов к API чата
// пытаемся добавить system-сообщение в тело. Форматы у чатов разные, поэтому
// распознаём несколько типовых структур (messages[], prompt, system, system_prompt).
//
// Безопасность прежде всего: любой сбой в разборе — запрос уходит как был.
// Ничего не блокируем, не подменяем ответы, не логируем тела.
//
// Настройки прилетают из content script (isolated world) через CustomEvent:
// MAIN world не имеет доступа к chrome.storage.

(function () {
  "use strict";

  if (window.__dsbridgeInjectInstalled) return;
  window.__dsbridgeInjectInstalled = true;

  var state = { enabled: false, prompt: "" };

  // ---------- канал настроек ----------
  window.addEventListener("__dsbridge_prompt", function (e) {
    var d = e && e.detail;
    if (!d || typeof d !== "object") return;
    state.enabled = d.enabled === true;
    state.prompt = typeof d.prompt === "string" ? d.prompt : "";
  });

  // ---------- эвристика: тот ли это запрос ----------
  // Хотим только POST к API чата. Список исключений — чтобы случайно не
  // дописать промпт в телеметрию, логин или загрузку файла.
  var API_HINTS = ["chat", "completion", "conversation", "message", "prompt", "generate", "reply"];
  var PATH_HINTS = ["/api/", "/backend-api/", "/v1/", "/graphql"];
  var EXCLUDE = [
    "health", "settings", "user", "login", "logout", "auth", "token", "billing",
    "usage", "feature", "event", "log", "track", "telemetry", "feedback", "share",
    "rate", "upload", "file", "asset", "analytics", "config", "session", "ping",
  ];

  function looksLikeChatApi(url, method) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    var u;
    try {
      u = new URL(url, location.href);
    } catch {
      return false;
    }
    var path = (u.pathname || "").toLowerCase();
    if (!PATH_HINTS.some(function (p) { return path.indexOf(p) >= 0; })) return false;
    if (EXCLUDE.some(function (x) { return path.indexOf(x) >= 0; })) return false;
    if (API_HINTS.some(function (h) { return path.indexOf(h) >= 0; })) return true;
    // graphql — отдельный случай: там всё через один эндпоинт, но в теле есть
    // operationName. Пока не трогаем, чтобы не сломать.
    return false;
  }

  // ---------- вставка в тело ----------
  // Возвращает новое тело (строку) или null, если вставить не удалось.
  function injectIntoBody(bodyText, prompt) {
    if (typeof bodyText !== "string" || !bodyText) return null;
    var obj;
    try {
      obj = JSON.parse(bodyText);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    // Форматы у чатов разные, и поля пересекаются: у Claude есть и `system`, и
    // `messages`. Поэтому обрабатываем РОВНО ОДИН формат — первый подходящий по
    // приоритету, — а не пытаемся применить всё сразу (иначе промпт задвоится).

    // 1) system: строка или массив блоков — так делает Claude.
    if (typeof obj.system === "string") {
      obj.system = prompt + "\n\n" + obj.system;
      return safeStringify(obj);
    }
    if (Array.isArray(obj.system)) {
      obj.system.unshift({ type: "text", text: prompt });
      return safeStringify(obj);
    }

    // 2) system_prompt / systemPrompt — строковые поля, встречаются у некоторых API.
    if (typeof obj.system_prompt === "string") {
      obj.system_prompt = prompt + "\n\n" + obj.system_prompt;
      return safeStringify(obj);
    }
    if (typeof obj.systemPrompt === "string") {
      obj.systemPrompt = prompt + "\n\n" + obj.systemPrompt;
      return safeStringify(obj);
    }

    var changed = false;

    // 3) messages: [{role, content}, ...] — формат OpenAI и большинства чатов.
    // Важно: чат ВСЕГДА шлёт свой system, поэтому «пропустить, если system уже
    // есть» означало бы «не работать никогда». Дополняем существующий system,
    // а если его нет — добавляем свой первым.
    if (Array.isArray(obj.messages)) {
      var sysIdx = -1;
      for (var i = 0; i < obj.messages.length; i++) {
        var m = obj.messages[i];
        if (m && (m.role === "system" || m.role === "developer")) { sysIdx = i; break; }
      }
      if (sysIdx >= 0) {
        var cur = obj.messages[sysIdx].content;
        if (typeof cur === "string") {
          obj.messages[sysIdx].content = prompt + "\n\n" + cur;
          changed = true;
        } else if (Array.isArray(cur)) {
          cur.unshift({ type: "text", text: prompt });
          changed = true;
        }
      } else {
        obj.messages.unshift({ role: "system", content: prompt });
        changed = true;
      }
    }

    // 4) prompt: строка (Claude.ai completion)
    if (!changed && typeof obj.prompt === "string" && obj.prompt.length > 0) {
      obj.prompt = prompt + "\n\n" + obj.prompt;
      changed = true;
    }

    if (!changed) return null;
    return safeStringify(obj);
  }

  // JSON.stringify, который никогда не бросает: циклические ссылки в теле чата —
  // не наша проблема, но и ронять запрос из-за них мы не имеем права.
  function safeStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  }

  // ---------- fetch ----------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        if (state.enabled && state.prompt) {
          var url = typeof input === "string" ? input : input && input.url;
          var method = (init && init.method) || (input && input.method) || "GET";
          if (looksLikeChatApi(url, method) && init && typeof init.body === "string") {
            var patched = injectIntoBody(init.body, state.prompt);
            if (patched !== null) {
              init = Object.assign({}, init, { body: patched });
            }
          }
        }
      } catch (e) {
        // Никогда не роняем запрос из-за своей ошибки.
        console.warn("[dsbridge] инжект промпта (fetch) не удался:", e && e.message);
      }
      return origFetch.apply(this, arguments.length > 1 ? [input, init] : [input]);
    };
  }

  // ---------- XMLHttpRequest ----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dsbMethod = method;
    this.__dsbUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (state.enabled && state.prompt && typeof body === "string") {
        if (looksLikeChatApi(this.__dsbUrl, this.__dsbMethod)) {
          var patched = injectIntoBody(body, state.prompt);
          if (patched !== null) body = patched;
        }
      }
    } catch (e) {
      console.warn("[dsbridge] инжект промпта (XHR) не удался:", e && e.message);
    }
    return origSend.call(this, body);
  };
})();
