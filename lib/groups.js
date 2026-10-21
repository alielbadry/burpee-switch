import { COLORS } from "./constants.js";
import {
  getContainers,
  getSettings,
  getTabMap,
  getTabContainer,
  setTabMap
} from "./store.js";
import { firstChar, mapLimit, sleep } from "./util.js";

let groupChain = Promise.resolve();
const toolbarIconCache = new Map();
const defaultIconCache = new Map();
const DEFAULT_ACTION_SIZES = [16, 48, 128];

function serializeGroupTask(task) {
  const run = groupChain.then(task, task);
  groupChain = run.catch(() => {});
  return run;
}

function toolbarIconData(container) {
  const initial = firstChar(container.name);
  const key = `${container.color}:${initial}`;
  if (toolbarIconCache.has(key)) return toolbarIconCache.get(key);
  try {
    const size = 32;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = COLORS[container.color]?.hex || COLORS.grey.hex;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(0, 0, size, size, 8);
    } else {
      ctx.rect(0, 0, size, size);
    }
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 18px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, size / 2, size / 2 + 1);
    const data = ctx.getImageData(0, 0, size, size);
    toolbarIconCache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

async function defaultIconData() {
  const images = {};
  for (const size of DEFAULT_ACTION_SIZES) {
    if (!defaultIconCache.has(size)) {
      const response = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
      if (!response.ok) throw new Error(`icon ${size} unavailable`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas context");
      ctx.drawImage(bitmap, 0, 0, size, size);
      bitmap.close?.();
      defaultIconCache.set(size, ctx.getImageData(0, 0, size, size));
    }
    images[size] = defaultIconCache.get(size);
  }
  return images;
}

export async function updateBadge(tabId, container, settings = null) {
  const resolved = settings || (await getSettings());
  try {
    const imageData = resolved.toolbarIcon ? toolbarIconData(container) : null;
    if (imageData) {
      await chrome.action.setIcon({ tabId, imageData });
    } else {
      try {
        await chrome.action.setIcon({ tabId, imageData: await defaultIconData() });
      } catch (error) {
        console.warn("Default icon reset failed", error);
      }
    }
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({
      tabId,
      title: `BURPEE-SWITCH: ${container.name}`
    });
  } catch (error) {
    console.warn("Badge update failed", error);
  }
}

function notifyTabVisuals(tabId, container, settings) {
  const data = {
    container: {
      id: container.id,
      name: container.name,
      color: container.color,
      hex: COLORS[container.color]?.hex || COLORS.grey.hex,
      initial: firstChar(container.name)
    },
    marker: settings.tabMarker,
    pageEdge: Boolean(settings.pageEdge)
  };
  chrome.tabs
    .sendMessage(tabId, { type: "containerVisual", data })
    .catch(() => {});
}

async function ungroupTabInner(tab) {
  if (!tab || tab.groupId === -1) return;
  try {
    await chrome.tabs.ungroup(tab.id);
  } catch {
    // Tab may be pinned, restricted, or already ungrouped.
  }
}

async function ungroupContainerGroup(tab, containerNames = null) {
  if (!tab || tab.groupId === -1) return;
  const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
  if (!group) return;
  let names = containerNames;
  if (!names) {
    const containers = await getContainers();
    names = new Set(containers.map((container) => container.name.trim().toLowerCase()));
  }
  if (!names.has((group.title || "").trim().toLowerCase())) return;
  await ungroupTabInner(tab);
}

async function findGroupByTitle(tab, title) {
  if (!tab || tab.windowId === undefined) return null;
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    return groups.find((group) => (group.title || "").trim() === title) || null;
  } catch {
    return null;
  }
}

async function ensureGroupedInner(tab, container) {
  if (!tab || container.id === "default" || tab.pinned) {
    await ungroupTabInner(tab);
    return;
  }

  const existing = await findGroupByTitle(tab, container.name.trim());
  if (existing) {
    try {
      if (tab.groupId !== existing.id) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
      }
      if (existing.color !== container.color) {
        await chrome.tabGroups.update(existing.id, { color: container.color });
      }
      return;
    } catch (error) {
      console.warn("Failed to add tab to existing group; creating a new group", error);
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) return;

    if (current.groupId !== -1) {
      const group = await chrome.tabGroups.get(current.groupId).catch(() => null);
      if (group && (group.title || "").trim() === container.name.trim()) {
        if (group.color !== container.color) {
          await chrome.tabGroups
            .update(group.id, { color: container.color })
            .catch(() => {});
        }
        return;
      }
    }

    try {
      const groupId = await chrome.tabs.group({
        tabIds: [current.id],
        createProperties: { windowId: current.windowId }
      });
      await chrome.tabGroups
        .update(groupId, { title: container.name, color: container.color })
        .catch((error) => {
          console.warn("Tab group vanished while styling it", error);
        });
      return;
    } catch (error) {
      if (attempt === 0) {
        await sleep(80);
        continue;
      }
      console.warn("Failed to create tab group", error);
    }
  }
}

export async function applyTabVisuals(tab, container, options = {}) {
  if (!tab) return;
  const settings = await getSettings();
  await updateBadge(tab.id, container, settings);
  notifyTabVisuals(tab.id, container, settings);
  const { containerNames = null, forceUngroup = false } = options;
  await serializeGroupTask(async () => {
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (!fresh) return;
    if (!settings.groupTabs || container.id === "default") {
      if (forceUngroup) await ungroupTabInner(fresh);
      else await ungroupContainerGroup(fresh, containerNames);
      return;
    }
    await ensureGroupedInner(fresh, container);
  });
}

export async function rebuildAssignments() {
  const containers = await getContainers();
  const settings = await getSettings();
  const byName = new Map(
    containers.map((container) => [container.name.trim().toLowerCase(), container])
  );
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  const map = {};
  const resolved = [];
  for (const tab of tabs) {
    let container = containers.find((item) => item.id === "default");
    if (tab.groupId !== -1) {
      const group = groupsById.get(tab.groupId);
      const match = group && byName.get((group.title || "").trim().toLowerCase());
      if (match) container = match;
    }
    map[String(tab.id)] = container.id;
    resolved.push({ tab, container });
  }

  await setTabMap(map);
  await mapLimit(resolved, 8, ({ tab, container }) =>
    updateBadge(tab.id, container, settings)
  );
  return map;
}

export async function applyAssignmentsToVisuals() {
  const containers = await getContainers();
  const byId = new Map(containers.map((container) => [container.id, container]));
  const defaultContainer = containers.find((container) => container.id === "default");
  const map = await getTabMap();
  const tabs = await chrome.tabs.query({});
  const containerNames = new Set(
    containers.map((container) => container.name.trim().toLowerCase())
  );
  await mapLimit(tabs, 8, async (tab) => {
    const containerId = map[String(tab.id)] || "default";
    const container = byId.get(containerId) || defaultContainer;
    await applyTabVisuals(tab, container, { containerNames });
  });
}

export async function removeContainerGroups() {
  const containers = await getContainers();
  const names = new Set(
    containers.map((container) => container.name.trim().toLowerCase())
  );
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({});
  } catch {
    return 0;
  }
  let removed = 0;
  for (const group of groups) {
    if (!names.has((group.title || "").trim().toLowerCase())) continue;
    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    if (tabs.length) {
      await chrome.tabs.ungroup(tabs.map((tab) => tab.id)).catch(() => {});
    }
    removed += 1;
  }
  return removed;
}

export async function syncTabVisuals(tabId) {
  const containers = await getContainers();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const containerId = (await getTabContainer(tabId)) || "default";
  const container =
    containers.find((item) => item.id === containerId) ||
    containers.find((item) => item.id === "default");
  await applyTabVisuals(tab, container);
}

export async function nameGroups(oldName, newName, color) {
  if (!oldName) return;
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({});
  } catch {
    return;
  }
  const target = oldName.trim().toLowerCase();
  for (const group of groups) {
    if ((group.title || "").trim().toLowerCase() !== target) continue;
    try {
      await chrome.tabGroups.update(group.id, { title: newName, color });
    } catch {
      // Group may have been closed.
    }
  }
}
