import { COLORS } from "../lib/constants.js";

const els = {
  currentLine: document.getElementById("currentLine"),
  liveHint: document.getElementById("liveHint"),
  containerList: document.getElementById("containerList"),
  incognitoNotice: document.getElementById("incognitoNotice"),
  sitePanel: document.getElementById("sitePanel"),
  domainLine: document.getElementById("domainLine"),
  isolateStorage: document.getElementById("isolateStorage"),
  siteContainer: document.getElementById("siteContainer"),
  applyRule: document.getElementById("applyRule"),
  clearRule: document.getElementById("clearRule"),
  ruleNote: document.getElementById("ruleNote"),
  settingsBtn: document.getElementById("settingsBtn"),
  manageBtn: document.getElementById("manageBtn"),
  regroupBtn: document.getElementById("regroupBtn"),
  toast: document.getElementById("toast")
};

let state = null;
let windowId = null;
let toastTimer = null;

async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Container action failed");
  return response.data;
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function colorOf(container) {
  return COLORS[container.color]?.hex || COLORS.grey.hex;
}

function containerLabel(container) {
  return `${container.icon || "📦"} ${container.name}`;
}

function renderContainers() {
  const { containers, currentContainerId, liveContainerId, incognito } = state;
  els.containerList.replaceChildren();

  for (const container of containers) {
    const isCurrent = container.id === currentContainerId;
    const isLive = container.id === liveContainerId;

    const item = document.createElement("li");
    item.className = `container-item${isCurrent ? " current" : ""}`;
    item.style.setProperty("--dot", colorOf(container));
    item.dataset.containerId = container.id;
    item.title = `Open a new tab in ${container.name}`;

    const icon = document.createElement("span");
    icon.className = "container-icon";
    icon.textContent = container.icon || "📦";
    icon.setAttribute("aria-hidden", "true");

    const meta = document.createElement("div");
    meta.className = "container-meta";

    const nameRow = document.createElement("div");
    nameRow.className = "container-name";
    const name = document.createElement("span");
    name.textContent = container.name;
    nameRow.append(name);
    if (isCurrent) {
      const dot = document.createElement("span");
      dot.className = "current-dot";
      dot.title = "Current tab";
      nameRow.append(dot);
    }

    const sub = document.createElement("div");
    sub.className = "container-sub";
    if (isCurrent && isLive) sub.textContent = "Current tab · active cookie jar";
    else if (isCurrent) sub.textContent = "Current tab";
    else if (isLive) sub.textContent = "Active cookie jar";
    else sub.textContent = container.id === "default" ? "Shared browser identity" : "Click to open a tab";

    meta.append(nameRow, sub);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "mini-btn";
    openBtn.textContent = "Open";
    openBtn.title = `Open a new tab in ${container.name}`;
    openBtn.disabled = incognito;
    openBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void openInContainer(container.id);
    });

    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "mini-btn";
    moveBtn.textContent = "Move";
    moveBtn.title = isCurrent
      ? "Current tab is already in this container"
      : `Move the current tab to ${container.name}`;
    moveBtn.disabled = incognito || isCurrent;
    moveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void moveCurrentTab(container.id);
    });

    actions.append(openBtn, moveBtn);
    item.append(icon, meta, actions);

    if (!incognito) {
      item.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        void openInContainer(container.id);
      });
    }

    els.containerList.append(item);
  }
}

function renderSitePanel() {
  const { domain, rule, containers, incognito } = state;
  if (!domain || incognito) {
    els.sitePanel.classList.add("hidden");
    return;
  }
  els.sitePanel.classList.remove("hidden");
  els.domainLine.textContent = domain;
  els.isolateStorage.checked = Boolean(state.storageIsolated);

  els.siteContainer.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a container…";
  els.siteContainer.append(placeholder);

  for (const container of containers) {
    const option = document.createElement("option");
    option.value = container.id;
    option.textContent = containerLabel(container);
    els.siteContainer.append(option);
  }
  els.siteContainer.value = rule?.containerId || "";

  const assigned = containers.find((container) => container.id === rule?.containerId);
  if (assigned) {
    els.ruleNote.replaceChildren(
      document.createTextNode("Assigned to "),
      Object.assign(document.createElement("strong"), {
        textContent: containerLabel(assigned)
      }),
      document.createTextNode(". New visits open there. Use Move to switch this tab now.")
    );
  } else {
    els.ruleNote.textContent = "No assignment for this site.";
  }

  els.applyRule.disabled = !els.siteContainer.value;
  els.clearRule.disabled = !rule;
}

function renderHeader() {
  const { containers, currentContainerId, liveContainerId } = state;
  const current =
    containers.find((container) => container.id === currentContainerId) ||
    containers.find((container) => container.id === "default");
  const live =
    containers.find((container) => container.id === liveContainerId) ||
    containers.find((container) => container.id === "default");

  els.currentLine.textContent = current
    ? `Current tab: ${containerLabel(current)}`
    : "No active tab";
  els.currentLine.title = els.currentLine.textContent;
  els.liveHint.textContent = live ? `ACTIVE TAB: ${live.name}` : "";
  els.incognitoNotice.classList.toggle("hidden", !state.incognito);
}

function render() {
  renderHeader();
  renderContainers();
  renderSitePanel();
}

async function openInContainer(containerId) {
  try {
    await call("openTabInContainer", { containerId, windowId });
    window.close();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function moveCurrentTab(containerId) {
  if (!state?.tabId) return;
  try {
    await call("moveTabToContainer", {
      tabId: state.tabId,
      containerId
    });
    window.close();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  windowId = tab?.windowId ?? null;
  state = await call("getPopupState", { tabId: tab?.id });
  render();
}

els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.manageBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

els.regroupBtn.addEventListener("click", async () => {
  try {
    await call("regroupAll");
    showToast("Tabs regrouped by container");
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

els.siteContainer.addEventListener("change", () => {
  els.applyRule.disabled = !els.siteContainer.value;
});

els.applyRule.addEventListener("click", async () => {
  if (!state?.domain || !els.siteContainer.value) return;
  try {
    await call("setSiteRule", {
      domain: state.domain,
      containerId: els.siteContainer.value
    });
    showToast(`Site assigned to ${els.siteContainer.selectedOptions[0]?.textContent || "container"}`);
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

els.clearRule.addEventListener("click", async () => {
  if (!state?.domain) return;
  try {
    await call("removeSiteRule", { domain: state.domain });
    showToast("Site assignment removed");
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

els.isolateStorage.addEventListener("change", async () => {
  if (!state?.domain) return;
  const enabled = els.isolateStorage.checked;
  try {
    await call("setSiteStorageIsolation", { domain: state.domain, enabled });
    showToast(
      enabled
        ? "Login storage isolation enabled. Sign in once in each container."
        : "Login storage isolation disabled"
    );
    await refresh();
  } catch (error) {
    els.isolateStorage.checked = !enabled;
    showToast(error.message, true);
  }
});

refresh().catch((error) => {
  els.currentLine.textContent = "Unable to load containers";
  showToast(error.message, true);
});
