const state = {
  csrfToken: sessionStorage.getItem("gmwebCsrfToken") || "",
  vncPath: "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let sseSource = null;

function loadNewMessageMap() {
  try { return new Map(JSON.parse(localStorage.getItem("gmweb_new_msgs") || "[]")); } catch { return new Map(); }
}
function saveNewMessageMap(map) {
  try { localStorage.setItem("gmweb_new_msgs", JSON.stringify([...map])); } catch {}
}

const newMessageMap = loadNewMessageMap();

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

function showApp(unlocked) {
  $("#loginPanel").classList.toggle("hidden", unlocked);
  $("#appShell").classList.toggle("hidden", !unlocked);
}

function showPasswordStep() {
  $("#passwordForm").classList.remove("hidden");
  $("#loginForm").classList.add("hidden");
  $("#loginHelp").textContent = "Sign in to continue.";
  $("#loginError").textContent = "";
  $("#passwordStepLabel").classList.add("active");
  $("#tokenStepLabel").classList.remove("active");
}

function showTokenStep() {
  $("#passwordForm").classList.add("hidden");
  $("#loginForm").classList.remove("hidden");
  $("#loginHelp").textContent = "Enter the API token to unlock the dashboard.";
  $("#loginError").textContent = "";
  $("#passwordStepLabel").classList.remove("active");
  $("#tokenStepLabel").classList.add("active");
}

function service(overview, name) {
  return (overview.services || []).find((item) => item.name === name) || {};
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function compactState(value) {
  if (value === "active") return "Active";
  if (value === "inactive") return "Off";
  if (value === "enabled") return "Enabled";
  return value ? value[0].toUpperCase() + value.slice(1) : "Unknown";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function connectSSE() {
  if (sseSource) return;
  sseSource = new EventSource("/events");
  sseSource.onopen = () => {
    loadConversations(true);
  };
  sseSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.type === "conversation_changed") {
      const conv = data.conversation || {};
      const id = conv.id || conv.href;
      const snippet = String(conv.snippet || conv.text || "").trim();
      const isIncoming = id && !snippet.startsWith("You:");
      if (isIncoming) {
        newMessageMap.set(id, (newMessageMap.get(id) || 0) + 1);
        saveNewMessageMap(newMessageMap);
      }
      loadConversations(true);
    }
  };
  sseSource.onerror = () => {
    sseSource.close();
    sseSource = null;
    setTimeout(connectSSE, 5000);
  };
}

function disconnectSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
}

async function refreshOverview() {
  const overview = await api("/admin/overview");
  const ready = overview.readiness || {};
  const status = ready.status || {};
  const apiService = service(overview, "gmweb-api.service");
  const chromeService = service(overview, "gmweb-chrome.service");
  const vncService = service(overview, "gmweb-vnc.service");
  const noVncService = service(overview, "gmweb-novnc.service");

  state.vncPath = overview.vnc?.proxyPath || state.vncPath;
  setText("#buildVersion", `v${overview.version}`);
  setText("#subtitle", `${overview.service} ${overview.version} - ${new Date(overview.now).toLocaleString()}`);
  setText("#pairingState", ready.ready ? "Paired" : "Not ready");
  setText("#pairingHint", cleanText(status.hint || status.title || ready.error || "-"));
  setText("#apiState", compactState(apiService.active));
  setText("#chromeState", compactState(chromeService.active));
  setText("#vncState", overview.vnc?.ready ? "Active" : `${compactState(vncService.active)} / ${compactState(noVncService.active)}`);
}

async function login(token) {
  const response = await fetch("/dashboard/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error("Invalid API token");
  const data = await response.json();
  state.csrfToken = data.csrfToken;
  sessionStorage.setItem("gmwebCsrfToken", state.csrfToken);
  showApp(true);
  await refreshOverview();
  loadConversations();
  connectSSE();
}

async function passwordLogin(username, password) {
  const response = await fetch("/dashboard/password-login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(`Too many attempts. Try again in ${data.retryAfterSeconds || response.headers.get("retry-after") || 60}s.`);
    }
    throw new Error("Invalid username or password");
  }
  return data;
}

async function logout() {
  await api("/dashboard/logout", { method: "POST" }).catch(() => {});
  disconnectSSE();
  newMessageMap.clear();
  sessionStorage.removeItem("gmwebCsrfToken");
  state.csrfToken = "";
  $("#vncFrame").src = "about:blank";
  showApp(false);
}

async function restoreSession() {
  const response = await fetch("/dashboard/session", { credentials: "same-origin" });
  if (!response.ok) return false;
  const session = await response.json();
  if (session.authenticated && session.csrfToken) {
    state.csrfToken = session.csrfToken;
    sessionStorage.setItem("gmwebCsrfToken", state.csrfToken);
    showApp(true);
    await refreshOverview();
    loadConversations();
    connectSSE();
    return true;
  }
  sessionStorage.removeItem("gmwebCsrfToken");
  state.csrfToken = "";
  showApp(false);
  if (session.passwordRequired && !session.passwordAuthenticated) {
    showPasswordStep();
  } else {
    showTokenStep();
  }
  return true;
}

async function runAction(action) {
  const label = $("#actionState");
  label.textContent = "Running";
  label.className = "pill";
  try {
    const result = await api("/admin/action", {
      method: "POST",
      body: JSON.stringify({ action })
    });
    label.textContent = result.queued ? "Queued" : (result.ok ? "Done" : "Failed");
    label.className = result.ok ? "pill ok" : "pill bad";
    setTimeout(refreshOverview, action.includes("restart") ? 4500 : 900);
  } catch (error) {
    label.textContent = error.message;
    label.className = "pill bad";
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const label = $("#sendState");
  label.textContent = "Sending";
  label.className = "pill";
  try {
    await api("/send", {
      method: "POST",
      body: JSON.stringify({
        to: $("#toInput").value.trim(),
        text: $("#textInput").value
      })
    });
    label.textContent = "Sent";
    label.className = "pill ok";
    $("#textInput").value = "";
  } catch (error) {
    label.textContent = error.message;
    label.className = "pill bad";
  }
}

function updateConversationsHeader() {
  const total = newMessageMap.size;
  const h2 = $("#conversations .panelHead h2");
  if (!h2) return;
  const badge = h2.querySelector(".headerBadge");
  if (total > 0) {
    if (badge) { badge.textContent = total; }
    else {
      const b = document.createElement("span");
      b.className = "headerBadge";
      b.textContent = total;
      h2.appendChild(b);
    }
  } else {
    badge?.remove();
  }
}

async function loadConversations(silent = false) {
  const list = $("#conversationList");
  if (!silent) list.replaceChildren(conversationMessage("Loading..."));
  try {
    const data = await api("/conversations?limit=50", { headers: { "Content-Type": "text/plain" } });
    list.replaceChildren();
    for (const item of data.conversations || []) {
      const id = item.id || item.href;
      const localCount = id ? (newMessageMap.get(id) || 0) : 0;
      const isUnread = item.unread || localCount > 0;

      // If server says read, clear local badge too
      if (!item.unread && localCount > 0 && id) {
        newMessageMap.delete(id);
        saveNewMessageMap(newMessageMap);
      }

      const row = document.createElement("div");
      row.className = "conversation" + (isUnread ? " unread" : "");

      const titleDiv = document.createElement("div");
      titleDiv.className = "convTitle";

      const strong = document.createElement("strong");
      strong.textContent = item.title || item.name || "Untitled";
      titleDiv.appendChild(strong);
      row.appendChild(titleDiv);

      const ts = document.createElement("small");
      ts.textContent = item.timestamp || "";
      row.appendChild(ts);

      const preview = document.createElement("small");
      preview.className = "preview";
      preview.textContent = item.preview || item.snippet || "";
      row.appendChild(preview);

      row.addEventListener("click", () => {
        if (id) { newMessageMap.delete(id); saveNewMessageMap(newMessageMap); }
        row.classList.remove("unread");
        updateConversationsHeader();
      });

      list.appendChild(row);
    }
    if (!list.children.length) {
      list.replaceChildren(conversationMessage("No conversations"));
    }
    updateConversationsHeader();
  } catch (error) {
    if (!silent) list.replaceChildren(conversationMessage(error.message));
  }
}

function conversationMessage(message) {
  const row = document.createElement("div");
  row.className = "conversation";
  const title = document.createElement("strong");
  title.textContent = message;
  row.appendChild(title);
  return row;
}

function openVnc() {
  $("#vncFrame").src = state.vncPath;
}

function bind() {
  $("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#loginError").textContent = "";
    try {
      await passwordLogin($("#usernameInput").value.trim(), $("#passwordInput").value);
      $("#passwordInput").value = "";
      showTokenStep();
    } catch (error) {
      $("#loginError").textContent = error.message;
    }
  });
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#loginError").textContent = "";
    try {
      await login($("#tokenInput").value.trim());
    } catch (error) {
      $("#loginError").textContent = error.message;
    }
  });
  $("#logoutBtn").addEventListener("click", logout);
  $("#refreshBtn").addEventListener("click", refreshOverview);
  $("#sendForm").addEventListener("submit", sendMessage);
  $("#loadConversationsBtn").addEventListener("click", () => {
    newMessageMap.clear();
    saveNewMessageMap(newMessageMap);
    loadConversations();
  });
  $("#openVncBtn").addEventListener("click", openVnc);
  $("#reloadVncBtn").addEventListener("click", openVnc);
  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });
}

bind();
restoreSession().then((ok) => {
  if (!ok) {
    showApp(false);
    showPasswordStep();
  }
}).catch(() => {
  showApp(false);
  showPasswordStep();
});

setInterval(() => {
  if (state.csrfToken) {
    refreshOverview().catch(() => {});
    loadConversations(true).catch(() => {});
  }
}, 8000);
