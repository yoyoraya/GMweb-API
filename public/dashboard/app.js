const state = {
  csrfToken: sessionStorage.getItem("gmwebCsrfToken") || "",
  vncPath: "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let sseSource = null;
let currentPanelItem = null;
let panelRefreshTimer = null;
let panelLoadId = 0;
let panelController = null;

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
    // Send-queue lifecycle events for the message we just queued
    if (data.jobId && data.jobId === pendingSendJobId) {
      if (data.type === "send_processing") setSendLabel("Sending...", "loading");
      else if (data.type === "send_completed") { setSendLabel("Sent", "ok"); pendingSendJobId = null; }
      else if (data.type === "send_failed") {
        if (data.willRetry) setSendLabel("Retrying...", "loading");
        else { setSendLabel(`Failed: ${data.error || "error"}`, "bad"); pendingSendJobId = null; }
      }
      return;
    }
    if (data.type === "conversation_changed") {
      const conv = data.conversation || {};
      const id = conv.id || conv.href;
      const snippet = String(conv.snippet || conv.text || "").trim();
      const isIncoming = id && !snippet.startsWith("You:");
      if (isIncoming) {
        newMessageMap.set(id, (newMessageMap.get(id) || 0) + 1);
        saveNewMessageMap(newMessageMap);
      }
      if (currentPanelItem && (currentPanelItem.id === id || currentPanelItem.href === id)) {
        // New message in the open conversation - refresh messages immediately
        loadConversationMessages(currentPanelItem, true).catch(() => {});
      } else if (!currentPanelItem) {
        loadConversations(true);
      } else {
        updateConversationsHeader();
      }
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

let pendingSendJobId = null;

function setSendLabel(text, cls = "") {
  const label = $("#sendState");
  label.textContent = text;
  label.className = "pill" + (cls ? " " + cls : "");
}

async function sendMessage(event) {
  event.preventDefault();
  setSendLabel("Queuing", "loading");
  try {
    const data = await api("/send", {
      method: "POST",
      body: JSON.stringify({
        to: $("#toInput").value.trim(),
        text: $("#textInput").value
      })
    });
    // Async queue: track jobId, update label as SSE events arrive
    pendingSendJobId = data.jobId;
    setSendLabel(`Queued${data.queuePosition > 1 ? ` (#${data.queuePosition})` : ""}`, "loading");
    $("#textInput").value = "";
    // Fallback poll in case SSE is not connected
    pollSendStatus(data.jobId);
  } catch (error) {
    setSendLabel(error.message, "bad");
  }
}

async function pollSendStatus(jobId, tries = 0) {
  if (pendingSendJobId !== jobId || tries > 40) return;
  try {
    const s = await api(`/send/status/${jobId}`, { headers: { "Content-Type": "text/plain" } });
    if (s.state === "completed") { setSendLabel("Sent", "ok"); pendingSendJobId = null; return; }
    if (s.state === "failed") { setSendLabel(`Failed: ${s.failedReason || "error"}`, "bad"); pendingSendJobId = null; return; }
    if (s.state === "active") setSendLabel("Sending...", "loading");
  } catch { /* ignore */ }
  setTimeout(() => pollSendStatus(jobId, tries + 1), 1500);
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
    const data = await api("/conversations?limit=500", { headers: { "Content-Type": "text/plain" } });
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

      if (item.pinned) {
        const pin = document.createElement("span");
        pin.className = "pinIcon";
        pin.textContent = "📌";
        titleDiv.appendChild(pin);
      }

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
        loadConversationMessages(item);
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

function buildMessageDivs(messages) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const div = document.createElement("div");
    if (msg.type === "timestamp") {
      div.className = "msg ts";
      div.textContent = msg.text;
    } else {
      const dir = msg.direction || "in";
      let prevDir = null, nextDir = null;
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].type === "message") { prevDir = messages[j].direction || "in"; break; }
      }
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].type === "message") { nextDir = messages[j].direction || "in"; break; }
      }
      const sameAsPrev = prevDir === dir;
      const sameAsNext = nextDir === dir;
      let group = "single";
      if (sameAsPrev && sameAsNext) group = "mid";
      else if (sameAsPrev) group = "last";
      else if (sameAsNext) group = "first";
      div.className = `msg ${dir}`;
      div.dataset.group = group;
      div.textContent = msg.text;
    }
    fragment.appendChild(div);
  }
  return fragment;
}

function showSkeletons(list) {
  list.replaceChildren();
  const dirs = ["in", "out", "out", "in", "out"];
  const widths = ["55%", "70%", "45%", "65%", "50%"];
  dirs.forEach((dir, i) => {
    const sk = document.createElement("div");
    sk.className = `msg ${dir} skeleton`;
    sk.style.width = widths[i];
    list.appendChild(sk);
  });
}

async function loadConversationMessages(item, silent = false) {
  const panel = $("#messagePanel");
  const list = $("#messageList");
  const stateEl = $("#msgLoadState");

  if (!silent) {
    // Cancel any in-flight request and mark new load
    if (panelController) panelController.abort();
    panelController = new AbortController();
    const myId = ++panelLoadId;

    currentPanelItem = item;
    panel.classList.remove("hidden");
    $("#messagePanelTitle").textContent = item.title || "Messages";
    stateEl.textContent = "";
    stateEl.className = "pill loading";
    showSkeletons(list);
    startPanelRefresh();

    const atBottom = true;
    try {
      const data = await api("/conversations/messages", {
        method: "POST",
        body: JSON.stringify({ href: item.href }),
        signal: panelController.signal
      });
      if (myId !== panelLoadId) return; // stale — user already clicked another
      const messages = data.messages || [];
      const msgCount = messages.filter(m => m.type === "message").length;
      if (msgCount > 0) {
        list.replaceChildren(buildMessageDivs(messages));
        list.scrollTop = list.scrollHeight;
        stateEl.textContent = `${msgCount} msgs`;
        stateEl.className = "pill ok";
      }
      // if 0 msgs: keep skeleton+spinner, interval will retry
    } catch (error) {
      if (panelLoadId !== myId || error.name === "AbortError") return;
      list.replaceChildren();
      stateEl.textContent = error.message;
      stateEl.className = "pill bad";
    }
    return;
  }

  // Silent refresh
  const myId = panelLoadId;
  const atBottom = list.querySelector(".skeleton") ||
    list.scrollHeight === 0 ||
    (list.scrollTop + list.clientHeight >= list.scrollHeight - 30);
  try {
    const data = await api("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({ href: item.href })
    });
    if (myId !== panelLoadId) return;
    const messages = data.messages || [];
    const msgCount = messages.filter(m => m.type === "message").length;
    if (msgCount > 0) {
      list.replaceChildren(buildMessageDivs(messages));
      if (atBottom) list.scrollTop = list.scrollHeight;
      stateEl.textContent = `${msgCount} msgs`;
      stateEl.className = "pill ok";
    }
  } catch { /* silent — ignore errors */ }
}

function startPanelRefresh() {
  stopPanelRefresh();
  panelRefreshTimer = setInterval(() => {
    if (currentPanelItem) loadConversationMessages(currentPanelItem, true).catch(() => {});
  }, 4000);
}

function stopPanelRefresh() {
  if (panelRefreshTimer) { clearInterval(panelRefreshTimer); panelRefreshTimer = null; }
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

// ─── API Key Management ────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function buildApiKeyRow(key, onDelete, onToggle) {
  const row = document.createElement("div");
  row.className = "apiKeyRow" + (key.enabled ? "" : " disabled");
  row.dataset.id = key.id;

  const info = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = key.name;
  info.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "apiKeyMeta";

  const preview = document.createElement("span");
  preview.textContent = key.tokenPreview;
  meta.appendChild(preview);

  (key.allowedIps || []).forEach((ip) => {
    const tag = document.createElement("span");
    tag.className = "ipTag";
    tag.textContent = ip;
    meta.appendChild(tag);
  });

  if (!key.allowedIps || key.allowedIps.length === 0) {
    const any = document.createElement("span");
    any.className = "ipTag";
    any.style.color = "var(--muted)";
    any.textContent = "any IP";
    meta.appendChild(any);
  }

  const stats = document.createElement("span");
  stats.textContent = `${key.requestCount || 0} reqs · last ${fmtDate(key.lastUsedAt)}`;
  meta.appendChild(stats);

  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "apiKeyActions";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "secondary";
  toggleBtn.style.fontSize = "12px";
  toggleBtn.textContent = key.enabled ? "Disable" : "Enable";
  toggleBtn.addEventListener("click", () => onToggle(key.id, !key.enabled));
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement("button");
  delBtn.style.fontSize = "12px";
  delBtn.style.color = "var(--red)";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => onDelete(key.id, key.name));
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

async function loadApiKeys() {
  const list = $("#apiKeyList");
  list.replaceChildren();
  try {
    const data = await api("/admin/api-keys");
    const keys = data.keys || [];
    if (!keys.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:16px;color:var(--muted);font-size:13px";
      empty.textContent = "No API keys yet. Create one above.";
      list.appendChild(empty);
      return;
    }
    for (const key of keys) {
      list.appendChild(buildApiKeyRow(key, deleteApiKey, toggleApiKey));
    }
  } catch (error) {
    list.textContent = error.message;
  }
}

async function deleteApiKey(id, name) {
  if (!confirm(`Delete key "${name}"?`)) return;
  try {
    await api(`/admin/api-keys/${id}`, { method: "DELETE" });
    loadApiKeys();
  } catch (error) {
    alert(error.message);
  }
}

async function toggleApiKey(id, enabled) {
  try {
    await api(`/admin/api-keys/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    });
    loadApiKeys();
  } catch (error) {
    alert(error.message);
  }
}

async function loadApiLogs() {
  const list = $("#apiLogList");
  list.replaceChildren();
  try {
    const data = await api("/admin/api-logs?limit=100");
    const logs = data.logs || [];
    if (!logs.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:16px;color:var(--muted);font-size:13px";
      empty.textContent = "No requests logged yet.";
      list.appendChild(empty);
      return;
    }
    for (const log of logs) {
      const row = document.createElement("div");
      row.className = "logRow";

      const ts = document.createElement("span");
      ts.textContent = new Date(log.ts).toLocaleString();
      row.appendChild(ts);

      const key = document.createElement("span");
      key.className = "logKey";
      key.textContent = log.keyName || "—";
      row.appendChild(key);

      const method = document.createElement("span");
      method.className = "logMethod";
      method.textContent = log.method;
      row.appendChild(method);

      const p = document.createElement("span");
      p.className = "logPath";
      p.textContent = log.path;
      row.appendChild(p);

      const ip = document.createElement("span");
      ip.className = "logIp";
      ip.textContent = log.ip;
      row.appendChild(ip);

      list.appendChild(row);
    }
  } catch (error) {
    list.textContent = error.message;
  }
}

// ──────────────────────────────────────────────────────────────────────────────

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
  $("#closeMsgBtn").addEventListener("click", () => {
    $("#messagePanel").classList.add("hidden");
    currentPanelItem = null;
    stopPanelRefresh();
    loadConversations(true).catch(() => {});
  });
  $("#openVncBtn").addEventListener("click", openVnc);
  $("#reloadVncBtn").addEventListener("click", openVnc);
  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });

  // API Keys
  $("#createKeyBtn").addEventListener("click", () => {
    $("#createKeyForm").classList.toggle("hidden");
    $("#newTokenBanner").classList.add("hidden");
    if (!$("#createKeyForm").classList.contains("hidden")) {
      $("#keyNameInput").focus();
    }
  });
  $("#cancelKeyBtn").addEventListener("click", () => {
    $("#createKeyForm").classList.add("hidden");
    $("#keyNameInput").value = "";
    $("#keyIpsInput").value = "";
  });
  $("#createKeyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#keyNameInput").value.trim();
    const ipsRaw = $("#keyIpsInput").value.trim();
    const allowedIps = ipsRaw ? ipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    try {
      const data = await api("/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({ name, allowedIps })
      });
      $("#createKeyForm").classList.add("hidden");
      $("#keyNameInput").value = "";
      $("#keyIpsInput").value = "";
      // Show token once
      const banner = $("#newTokenBanner");
      banner.classList.remove("hidden");
      $("#newTokenValue").textContent = data.key.token;
      loadApiKeys();
    } catch (error) {
      alert(error.message);
    }
  });
  $("#copyTokenBtn").addEventListener("click", () => {
    const val = $("#newTokenValue").textContent;
    navigator.clipboard.writeText(val).then(() => {
      $("#copyTokenBtn").textContent = "Copied!";
      setTimeout(() => { $("#copyTokenBtn").textContent = "Copy"; }, 2000);
    });
  });
  $("#refreshLogsBtn").addEventListener("click", loadApiLogs);

  // Toggle API Keys section visibility and load data
  $$(".nav a").forEach((link) => {
    link.addEventListener("click", (e) => {
      const hash = link.getAttribute("href");
      if (hash === "#apikeys") {
        e.preventDefault();
        const section = $("#apikeys");
        const isHidden = section.classList.contains("hidden");
        section.classList.toggle("hidden", !isHidden);
        if (isHidden) {
          loadApiKeys();
          loadApiLogs();
          section.scrollIntoView({ behavior: "smooth" });
        }
        $$(".nav a").forEach((a) => a.classList.remove("active"));
        if (isHidden) link.classList.add("active");
      }
    });
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
    if (!currentPanelItem) loadConversations(true).catch(() => {});
  }
}, 8000);
