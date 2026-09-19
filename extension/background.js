// Единственная точка доступа к локальному мосту.
// Живёт в service worker: благодаря host_permissions fetch не подчиняется CORS,
// а FileReader здесь недоступен — поэтому base64 собираем вручную.
const BRIDGE = "http://127.0.0.1:8443";

async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || "";
}

async function callBridge(pathname, options = {}) {
  const token = await getToken();
  const res = await fetch(BRIDGE + pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": token,
      ...(options.headers || {}),
    },
  });
  return res.json();
}

// blob -> data:URL. В service worker нет FileReader, поэтому кодируем сами.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // не даём переполнить стек при apply()
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:" + (blob.type || "application/octet-stream") + ";base64," + btoa(bin);
}

function rawUrl(relPath, download) {
  return (
    BRIDGE +
    "/api/raw?path=" +
    encodeURIComponent(relPath) +
    (download ? "&download=1" : "")
  );
}

async function tokenizedRawUrl(relPath, download) {
  const token = await getToken();
  return rawUrl(relPath, download) + "&token=" + encodeURIComponent(token);
}

// Картинка из рабочей папки -> data:URL (обходит mixed-content и CSP страницы).
async function fetchRaw(relPath) {
  const url = await tokenizedRawUrl(relPath, false);
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.status + " " + res.statusText;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch {
      // тело не JSON — оставляем статус
    }
    return { ok: false, error: { code: "ERAW", message: detail } };
  }
  const blob = await res.blob();
  return { ok: true, dataUrl: await blobToDataUrl(blob), size: blob.size, type: blob.type };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "health") {
        sendResponse(await callBridge("/api/health"));
      } else if (msg.type === "tools") {
        sendResponse(await callBridge("/api/tools"));
      } else if (msg.type === "tool") {
        sendResponse(
          await callBridge("/api/tool", {
            method: "POST",
            body: JSON.stringify({ tool: msg.tool, args: msg.args || {} }),
          }),
        );
      } else if (msg.type === "raw") {
        sendResponse(await fetchRaw(msg.path));
      } else if (msg.type === "openFile") {
        sendResponse(
          await callBridge("/api/open-file", {
            method: "POST",
            body: JSON.stringify({ path: msg.path }),
          }),
        );
      } else if (msg.type === "openRaw") {
        // Скачивание/открытие в новой вкладке: токен в query, т.к. <a href> его не отправит.
        const url = await tokenizedRawUrl(msg.path, !!msg.download);
        await chrome.tabs.create({ url });
        sendResponse({ ok: true, url: rawUrl(msg.path, !!msg.download) });
      } else if (msg.type === "pickFolder") {
        const res = await callBridge("/api/pick-folder", { method: "POST", body: "{}" });
        if (res && res.ok && res.path) {
          // Popup обычно закрывается, как только всплывает системный диалог,
          // поэтому результат сохраняем — popup прочитает его при следующем открытии.
          await chrome.storage.local.set({ lastPicked: res.path });
        }
        sendResponse(res);
      } else if (msg.type === "settings") {
        sendResponse(
          await callBridge("/api/settings", {
            method: "POST",
            body: JSON.stringify(msg.patch || {}),
          }),
        );
      } else if (msg.type === "openWorkspace") {
        sendResponse(await callBridge("/api/open", { method: "POST", body: "{}" }));
      } else {
        sendResponse({ ok: false, error: { code: "EMSG", message: "Неизвестный тип сообщения" } });
      }
    } catch (e) {
      sendResponse({ ok: false, error: { code: "EBRIDGE", message: "Мост недоступен: " + e.message } });
    }
  })();
  return true; // асинхронный ответ
});
