const state = {
  token: localStorage.getItem("gmwebToken") || "",
  vncPath: "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${state.token}`
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders({
      "Content-Type": "application/json",
      ...(options.headers || {})
    })
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
  $("#appPanel").classList.toggle("hidden", !unlocked);
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
  setText("#subtitle", `${overview.service} ${overview.version} · ${new Date(overview.now).toLocaleString()}`);
  setText("#pairingState", ready.ready ? "Paired" : "Not ready");
  setText("#pairingHint", cleanText(status.hint || status.title || ready.error || "-"));
  setText("#apiState", compactState(apiService.active));
  setText("#chromeState", compactState(chromeService.active));
  setText("#vncState", overview.vnc?.ready ? "Active" : `${compactState(vncService.active)} / ${compactState(noVncService.active)}`);
}

async function login(token) {
  const response = await fetch("/dashboard/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error("Invalid API token");
  state.token = token;
  localStorage.setItem("gmwebToken", token);
  showApp(true);
  await refreshOverview();
}

async function logout() {
  await fetch("/dashboard/logout", { method: "POST" }).catch(() => {});
  localStorage.removeItem("gmwebToken");
  state.token = "";
  $("#vncFrame").src = "about:blank";
  showApp(false);
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

async function loadConversations() {
  const list = $("#conversationList");
  list.innerHTML = "<div class=\"conversation\"><strong>Loading...</strong></div>";
  try {
    const data = await api("/conversations?limit=12", { headers: { "Content-Type": "text/plain" } });
    list.innerHTML = "";
    for (const item of data.conversations || []) {
      const row = document.createElement("div");
      row.className = "conversation";
      row.innerHTML = "<strong></strong><small></small><small class=\"preview\"></small>";
      row.querySelector("strong").textContent = item.title || item.name || "Untitled";
      row.querySelector("small").textContent = item.timestamp || "";
      row.querySelector(".preview").textContent = item.preview || item.snippet || "";
      list.appendChild(row);
    }
    if (!list.children.length) {
      list.innerHTML = "<div class=\"conversation\"><strong>No conversations</strong></div>";
    }
  } catch (error) {
    list.innerHTML = `<div class="conversation"><strong>${error.message}</strong></div>`;
  }
}

function openVnc() {
  $("#vncFrame").src = state.vncPath;
}

function bind() {
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
  $("#loadConversationsBtn").addEventListener("click", loadConversations);
  $("#openVncBtn").addEventListener("click", openVnc);
  $("#reloadVncBtn").addEventListener("click", openVnc);
  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });
}

bind();
if (state.token) {
  $("#tokenInput").value = state.token;
  login(state.token).catch(() => showApp(false));
} else {
  showApp(false);
}

setInterval(() => {
  if (state.token) refreshOverview().catch(() => {});
}, 8000);
