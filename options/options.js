import { COLORS, COLOR_NAMES } from "../lib/constants.js";

const els = {
  liveChip: document.getElementById("liveChip"),
  containerRows: document.getElementById("containerRows"),
  newIcon: document.getElementById("newIcon"),
  newName: document.getElementById("newName"),
  newColor: document.getElementById("newColor"),
  addContainer: document.getElementById("addContainer"),
  ruleRows: document.getElementById("ruleRows"),
  ruleDomain: document.getElementById("ruleDomain"),
  ruleContainer: document.getElementById("ruleContainer"),
  addRule: document.getElementById("addRule"),
  groupTabs: document.getElementById("groupTabs"),
  regroupBtn: document.getElementById("regroupBtn"),
  ungroupBtn: document.getElementById("ungroupBtn"),
  tabMarker: document.getElementById("tabMarker"),
  pageEdge: document.getElementById("pageEdge"),
  toolbarIcon: document.getElementById("toolbarIcon"),
  burpHeaders: document.getElementById("burpHeaders"),
  autoReload: document.getElementById("autoReload"),
  paused: document.getElementById("paused"),
  applyMarkersBtn: document.getElementById("applyMarkersBtn"),
  toast: document.getElementById("toast")
};

let state = null;
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
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3400);
}

function colorHex(name) {
  return COLORS[name]?.hex || COLORS.grey.hex;
}

function labelFor(container) {
  return `${container.icon || "📦"} ${container.name}`;
}

function fillColorSelect(select, selected) {
  select.replaceChildren();
  for (const name of COLOR_NAMES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = COLORS[name].label;
    select.append(option);
  }
  select.value = COLOR_NAMES.includes(selected) ? selected : "blue";
}

function renderContainers() {
  const { containers, liveContainerId } = state;
  els.containerRows.replaceChildren();

  for (const container of containers) {
    const row = document.createElement("div");
    row.className = `container-row${container.locked ? " locked" : ""}`;
    row.style.setProperty("--dot", colorHex(container.color));

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.title = COLORS[container.color]?.label || "Grey";

    const icon = document.createElement("input");
    icon.className = "input icon-input";
    icon.type = "text";
    icon.maxLength = 8;
    icon.value = container.icon || "📦";
    icon.disabled = Boolean(container.locked);
    icon.setAttribute("aria-label", `Icon for ${container.name}`);

    const name = document.createElement("input");
    name.className = "input name-input";
    name.type = "text";
    name.maxLength = 24;
    name.value = container.name;
    name.disabled = Boolean(container.locked);
    name.setAttribute("aria-label", `Name for ${container.name}`);

    const color = document.createElement("select");
    color.className = "input color-input";
    color.disabled = Boolean(container.locked);
    color.setAttribute("aria-label", `Color for ${container.name}`);
    fillColorSelect(color, container.color);

    color.addEventListener("change", () => {
      swatch.style.background = colorHex(color.value);
    });

    const note = document.createElement("span");
    note.className = "row-note";
    if (container.locked) note.textContent = "Default";
    else if (container.id === liveContainerId) note.textContent = "ACTIVE TAB";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    if (!container.locked) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn ghost";
      save.textContent = "Save";
      save.addEventListener("click", async () => {
        try {
          await call("updateContainer", {
            id: container.id,
            patch: { icon: icon.value, name: name.value, color: color.value }
          });
          showToast(`Saved ${name.value || "container"}`);
          await refresh();
        } catch (error) {
          showToast(error.message, true);
        }
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        const confirmed = confirm(
          `Delete "${container.name}"? Its saved cookie jar and site assignments will be removed.`
        );
        if (!confirmed) return;
        try {
          await call("deleteContainer", { id: container.id });
          showToast(`Deleted ${container.name}`);
          await refresh();
        } catch (error) {
          showToast(error.message, true);
        }
      });

      actions.append(save, remove);
    }

    row.append(swatch, icon, name, color, note, actions);
    els.containerRows.append(row);
  }
}

function fillRuleContainers() {
  const previous = els.ruleContainer.value;
  els.ruleContainer.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a container…";
  els.ruleContainer.append(placeholder);

  for (const container of state.containers) {
    const option = document.createElement("option");
    option.value = container.id;
    option.textContent = labelFor(container);
    els.ruleContainer.append(option);
  }

  if (state.containers.some((container) => container.id === previous)) {
    els.ruleContainer.value = previous;
  } else {
    els.ruleContainer.value =
      state.containers.find((container) => container.id !== "default")?.id || "";
  }
}

function renderRules() {
  const { siteRules, containers } = state;
  els.ruleRows.replaceChildren();
  fillRuleContainers();

  if (siteRules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No site assignments yet. Assign a site from the extension popup.";
    els.ruleRows.append(empty);
    return;
  }

  for (const rule of siteRules) {
    const container = containers.find((item) => item.id === rule.containerId);
    const row = document.createElement("div");
    row.className = "rule-row";

    const domain = document.createElement("span");
    domain.className = "rule-domain";
    domain.textContent = rule.domain;
    domain.title = rule.domain;

    const target = document.createElement("span");
    target.className = "rule-target";
    target.textContent = container ? `→ ${labelFor(container)}` : "→ missing container";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      try {
        await call("removeSiteRule", { domain: rule.domain });
        showToast(`Removed ${rule.domain}`);
        await refresh();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    row.append(domain, target, remove);
    els.ruleRows.append(row);
  }
}

function render() {
  const live = state.containers.find((container) => container.id === state.liveContainerId);
  els.liveChip.textContent = live ? `ACTIVE TAB: ${labelFor(live)}` : "ACTIVE TAB: —";
  els.groupTabs.checked = Boolean(state.settings.groupTabs);
  els.regroupBtn.disabled = !state.settings.groupTabs;
  els.tabMarker.value = state.settings.tabMarker || "favicon-dot";
  els.pageEdge.checked = Boolean(state.settings.pageEdge);
  els.toolbarIcon.checked = Boolean(state.settings.toolbarIcon);
  els.burpHeaders.checked = Boolean(state.settings.burpHeaders);
  els.autoReload.checked = state.settings.autoReload !== false;
  els.paused.checked = Boolean(state.settings.paused);
  renderContainers();
  renderRules();
}

async function refresh() {
  state = await call("getOptionsState");
  render();
}

async function addContainer() {
  try {
    const created = await call("createContainer", {
      name: els.newName.value,
      icon: els.newIcon.value,
      color: els.newColor.value
    });
    els.newName.value = "";
    showToast(`Created ${created.name}`);
    await refresh();
    els.newName.focus();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function addRule() {
  const domain = els.ruleDomain.value.trim();
  const containerId = els.ruleContainer.value;
  if (!domain) {
    showToast("Enter a domain, for example example.com", true);
    els.ruleDomain.focus();
    return;
  }
  if (!containerId) {
    showToast("Choose a container for this domain", true);
    els.ruleContainer.focus();
    return;
  }
  try {
    await call("setSiteRule", { domain, containerId });
    els.ruleDomain.value = "";
    showToast(`Assigned ${domain}`);
    await refresh();
    els.ruleDomain.focus();
  } catch (error) {
    showToast(error.message, true);
  }
}

els.addContainer.addEventListener("click", () => void addContainer());
els.newName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addContainer();
  }
});
els.addRule.addEventListener("click", () => void addRule());
els.ruleDomain.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addRule();
  }
});

els.groupTabs.addEventListener("change", async () => {
  try {
    await call("setGrouping", { enabled: els.groupTabs.checked });
    showToast(els.groupTabs.checked ? "Tab grouping enabled" : "Tab grouping disabled");
    await refresh();
  } catch (error) {
    showToast(error.message, true);
    els.groupTabs.checked = !els.groupTabs.checked;
  }
});

els.regroupBtn.addEventListener("click", async () => {
  try {
    await call("regroupAll");
    showToast("Tabs regrouped by container");
  } catch (error) {
    showToast(error.message, true);
  }
});

els.ungroupBtn.addEventListener("click", async () => {
  try {
    const removed = await call("removeContainerGroups");
    showToast(`Removed ${Number(removed) || 0} container group(s)`);
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

async function saveVisualSettings() {
  try {
    state.settings = await call("setVisualSettings", {
      tabMarker: els.tabMarker.value,
      pageEdge: els.pageEdge.checked,
      toolbarIcon: els.toolbarIcon.checked,
      burpHeaders: els.burpHeaders.checked,
      autoReload: els.autoReload.checked,
      paused: els.paused.checked
    });
    showToast("Behavior updated");
  } catch (error) {
    showToast(error.message, true);
  }
}

els.tabMarker.addEventListener("change", () => void saveVisualSettings());
els.pageEdge.addEventListener("change", () => void saveVisualSettings());
els.toolbarIcon.addEventListener("change", () => void saveVisualSettings());
els.burpHeaders.addEventListener("change", () => void saveVisualSettings());
els.autoReload.addEventListener("change", () => void saveVisualSettings());
els.paused.addEventListener("change", () => void saveVisualSettings());

els.applyMarkersBtn.addEventListener("click", async () => {
  try {
    await call("refreshTabMarkers");
    showToast("Applied to open tabs");
  } catch (error) {
    showToast(error.message, true);
  }
});

fillColorSelect(els.newColor, "blue");
refresh().catch((error) => showToast(error.message, true));
