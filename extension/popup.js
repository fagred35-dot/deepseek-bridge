const BRIDGE = "http://127.0.0.1:8443";

const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const tokenInput = document.getElementById("token");
const promptOn = document.getElementById("promptOn");
const promptBox = document.getElementById("prompt");
const personaSel = document.getElementById("persona");
const wsEl = document.getElementById("ws");
const pathInput = document.getElementById("path");
const warnEl = document.getElementById("warn");

function setStatus(ok, text) {
  dot.className = "dot " + (ok ? "on" : "off");
  statusEl.textContent = text;
}

function setWorkspace(p) {
  wsEl.textContent = p || "—";
  if (p && !pathInput.value) pathInput.value = p;
}

// Прямая проверка в обход background — чтобы отличить «мост недоступен»
// от «фоновая часть расширения не отвечает».
async function directHealth(token) {
  const res = await fetch(BRIDGE + "/api/health", { headers: { "X-Bridge-Token": token } });
  return res.json();
}

async function check() {
  const token = tokenInput.value.trim();
  setStatus(false, "проверяю…");

  try {
    const res = await chrome.runtime.sendMessage({ type: "health" });
    if (res && res.ok) {
      setStatus(true, "подключено");
      setWorkspace(res.workspace);
      return;
    }
    if (res && res.error) {
      setStatus(false, res.error.message || "ошибка");
      return;
    }
    setStatus(false, "фон не ответил, проверяю напрямую…");
  } catch (e) {
    setStatus(false, "фон недоступен, проверяю напрямую…");
  }

  try {
    const j = await directHealth(token);
    if (j && j.ok) {
      setStatus(true, "подключено напрямую");
      setWorkspace(j.workspace);
    } else setStatus(false, "мост ответил без ok");
  } catch (e) {
    setStatus(false, "мост недоступен: " + e.message);
  }
}

// Список персонажей тянем с моста. Не удалось — оставляем только «не выбран»:
// панель не должна ломаться из-за недоступного моста.
async function loadPersonas(token) {
  try {
    const res = await fetch(BRIDGE + "/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({ tool: "persona_list", args: {} }),
    });
    const j = await res.json();
    const list = j && j.ok && j.result && Array.isArray(j.result.personas) ? j.result.personas : [];
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.description ? p.name + " — " + p.description : p.name;
      personaSel.append(opt);
    }
  } catch {
    // мост недоступен — просто нет списка
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({
    token,
    systemPrompt: { enabled: promptOn.checked, text: promptBox.value },
    personaName: personaSel.value || "",
  });
  await check();
});

document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.create({ url: BRIDGE + "/" });
});

// Смена рабочей папки через системный диалог.
// Popup закрывается, как только диалог получает фокус, поэтому ответ может
// не дойти — сам запрос до моста доезжает, папка меняется и сохраняется.
document.getElementById("pick").addEventListener("click", async () => {
  warnEl.classList.add("show");
  setStatus(true, "открываю диалог выбора папки…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "pickFolder" });
    if (res && res.ok && res.path) {
      setWorkspace(res.path);
      pathInput.value = res.path;
      setStatus(true, "папка изменена");
      warnEl.classList.remove("show");
    } else if (res && res.cancelled) {
      setStatus(true, "выбор отменён");
      warnEl.classList.remove("show");
    } else {
      setStatus(false, (res && res.error && res.error.message) || "не удалось выбрать папку");
    }
  } catch (e) {
    setStatus(false, "фон недоступен: " + e.message);
  }
});

document.getElementById("applyPath").addEventListener("click", async () => {
  const value = pathInput.value.trim();
  if (!value) return;
  setStatus(true, "применяю путь…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "settings", patch: { workspaceRoot: value } });
    if (res && res.ok) {
      setWorkspace(res.workspace);
      setStatus(true, "рабочая папка изменена");
    } else {
      setStatus(false, (res && res.error && res.error.message) || "не удалось применить путь");
    }
  } catch (e) {
    setStatus(false, "фон недоступен: " + e.message);
  }
});

document.getElementById("openWs").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "openWorkspace" });
  } catch {
    // молча: открытие проводника — не критичная операция
  }
});

(async () => {
  const { token, lastPicked, systemPrompt, personaName } = await chrome.storage.local.get([
    "token",
    "lastPicked",
    "systemPrompt",
    "personaName",
  ]);
  if (token) tokenInput.value = token;
  if (lastPicked) pathInput.value = lastPicked;
  if (systemPrompt && typeof systemPrompt === "object") {
    promptOn.checked = systemPrompt.enabled === true;
    promptBox.value = typeof systemPrompt.text === "string" ? systemPrompt.text : "";
  }
  await loadPersonas(token || "");
  if (personaName) personaSel.value = personaName;
  await check();
  if (lastPicked) await chrome.storage.local.remove("lastPicked");
})();
