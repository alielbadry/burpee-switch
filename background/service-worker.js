import {
  COLORS,
  COLOR_NAMES,
  MAX_ICON_LENGTH,
  MAX_NAME_LENGTH,
  TAB_MARKERS
} from "../lib/constants.js";
import {
  deleteJar,
  ensureSeeded,
  getContainers,
  getMeta,
  getSettings,
  getSiteRules,
  getTabContainer,
  getTabLoadedJar,
  getTabMap,
  getTabOverrides,
  getTabStorageLoad,
  removeTabContainer,
  removeTabLoadedJar,
  removeTabOverride,
  removeTabStorageLoad,
  setContainers,
  setMeta,
  setSettings,
  setSiteRules,
  setTabContainer,
  setTabLoadedJar,
  setTabMap,
  setTabOverride,
  setTabStorageLoad,
  getTabRestoreSnapshot,
  setTabRestoreSnapshot
} from "../lib/store.js";
import { recoverSwap, swapLiveContainer, syncLiveJar } from "../lib/jars.js";
import {
  applyAssignmentsToVisuals,
  applyTabVisuals,
  nameGroups,
  removeContainerGroups,
  syncTabVisuals
} from "../lib/groups.js";
import {
  firstChar,
  getDomain,
  hostMatchesRule,
  isWebUrl,
  mapLimit,
  newId,
  normalizeDomain,
  sleep
} from "../lib/util.js";

let readyPromise = null;
let swapTimer = null;
let swapBusy = false;
let pendingSwapTabId = null;
let settingsApplyChain = Promise.resolve();

function queueSettingsApply(task) {
  const run = settingsApplyChain.then(task, task);
  settingsApplyChain = run.catch(() => {});
  return run;
}

const BURP_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other"
];
let burpRuleChain = Promise.resolve();

function queueBurpRule(task) {
  const run = burpRuleChain.then(task, task);
  burpRuleChain = run.catch(() => {});
  return run;
}

function burpHeaderValue(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 200)
    .trim();
}

function burpRuleFor(tabId, container) {
  const name = burpHeaderValue(container.name);
  if (!name) return null;
  return {
    id: tabId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "X-Container-Name", operation: "set", value: name },
        { header: "X-Container-Color", operation: "set", value: burpHeaderValue(container.color) },
        { header: "X-Container-Tab", operation: "set", value: String(tabId) }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: BURP_RESOURCE_TYPES
    }
  };
}

async function syncBurpHeaderForTab(tabId) {
  return queueBurpRule(async () => {
    if (!chrome.declarativeNetRequest?.updateSessionRules) return;
    const removeRuleIds = [tabId];
    const settings = await getSettings();
    if (!settings.burpHeaders) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds }).catch(() => {});
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const assigned = tab ? (await getTabContainer(tabId)) || "default" : "default";
    const containers = await getContainers();
    const container = containers.find((item) => item.id === assigned);
    const rule =
      tab && !tab.incognito && container && container.id !== "default"
        ? burpRuleFor(tabId, container)
        : null;
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds, addRules: rule ? [rule] : [] })
      .catch(() => {});
  });
}

async function syncAllBurpHeaders() {
  return queueBurpRule(async () => {
    if (!chrome.declarativeNetRequest?.updateSessionRules) return;
    const existing = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
    const removeRuleIds = existing.map((rule) => rule.id);
    const settings = await getSettings();
    if (!settings.burpHeaders) {
      if (removeRuleIds.length) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds }).catch(() => {});
      }
      return;
    }
    const [tabs, map, containers] = await Promise.all([
      chrome.tabs.query({}),
      getTabMap(),
      getContainers()
    ]);
    const addRules = tabs
      .filter((tab) => !tab.incognito)
      .map((tab) => {
        const assigned = map[String(tab.id)] || "default";
        const container = containers.find((item) => item.id === assigned);
        return container && container.id !== "default" ? burpRuleFor(tab.id, container) : null;
      })
      .filter(Boolean);
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds, addRules })
      .catch(() => {});
  });
}

function ready() {
  if (!readyPromise) {
    readyPromise = bootstrap().catch((error) => {
      console.error("Containers bootstrap failed", error);
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

async function migrateGroupingDefault() {
  const flag = await chrome.storage.local.get("groupingDefaultMigration");
  const version = Number(flag.groupingDefaultMigration) || 0;
  if (version >= 2) return;
  await setSettings({ groupTabs: false });
  await removeContainerGroups();
  await applyAssignmentsToVisuals();
  await chrome.storage.local.set({ groupingDefaultMigration: 2 });
}

async function migrateTabEdgeDefault() {
  const flag = await chrome.storage.local.get("tabEdgeDefaultMigration");
  if (Number(flag.tabEdgeDefaultMigration) >= 1) return;
  await setSettings({ pageEdge: true });
  await applyAssignmentsToVisuals();
  await chrome.storage.local.set({ tabEdgeDefaultMigration: 1 });
}

async function migrateToolbarBrand() {
  const flag = await chrome.storage.local.get("toolbarBrandMigration");
  if (Number(flag.toolbarBrandMigration) >= 1) return;
  await setSettings({ toolbarIcon: false });
  await applyAssignmentsToVisuals();
  await chrome.storage.local.set({ toolbarBrandMigration: 1 });
}

let snapshotTimer = null;
let snapshotSuppressedUntil = 0;
const startupPreservedTabIds = new Set();
const startupNeedsReload = new Set();
let startupPreserveUntil = 0;

function scheduleTabSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    void saveTabSnapshot().catch((error) => console.warn("Tab snapshot failed", error));
  }, 250);
}

async function saveTabSnapshot() {
  if (Date.now() < snapshotSuppressedUntil) return;
  const [tabs, map, overrides, windows] = await Promise.all([
    chrome.tabs.query({}),
    getTabMap(),
    getTabOverrides(),
    chrome.windows.getAll({ populate: false }).catch(() => [])
  ]);
  const windowOrder = new Map(windows.map((win, index) => [win.id, index]));
  const snapshot = {
    savedAt: Date.now(),
    tabs: tabs
      .filter((tab) => !tab.incognito)
      .map((tab) => ({
        url: tab.url || tab.pendingUrl || "",
        containerId: map[String(tab.id)] || "default",
        override: Boolean(overrides[String(tab.id)]),
        window: windowOrder.get(tab.windowId) ?? 0,
        index: tab.index,
        pinned: Boolean(tab.pinned),
        active: Boolean(tab.active)
      }))
  };
  await setTabRestoreSnapshot(snapshot);
}

function snapshotTabUrl(tab) {
  return tab.url || tab.pendingUrl || "";
}

function snapshotMatchScore(entry, tab, windowOrder) {
  const entryUrl = entry.url || "";
  const tabUrl = snapshotTabUrl(tab);
  let score = -1;
  if (entryUrl && tabUrl === entryUrl) {
    score = 100;
  } else {
    const entryHost = getDomain(entryUrl);
    const tabHost = getDomain(tabUrl);
    if (entryHost && tabHost && entryHost === tabHost) score = 20;
  }
  if (score < 0) return -1;
  if ((windowOrder.get(tab.windowId) ?? -1) === entry.window) score += 5;
  if (tab.index === entry.index) score += 3;
  if (Boolean(tab.pinned) === Boolean(entry.pinned)) score += 1;
  if (Boolean(tab.active) === Boolean(entry.active)) score += 1;
  return score;
}

async function restoreStartupAssignments() {
  const [snapshot, containers, rules, settings] = await Promise.all([
    getTabRestoreSnapshot(),
    getContainers(),
    getSiteRules(),
    getSettings()
  ]);
  const byId = new Map(containers.map((container) => [container.id, container]));
  const tabs = (await chrome.tabs.query({})).filter((tab) => !tab.incognito);
  if (!tabs.length) return 0;

  const windows = await chrome.windows.getAll({ populate: false }).catch(() => []);
  const windowOrder = new Map(windows.map((win, index) => [win.id, index]));
  const decided = new Set();
  const hasSnapshot = Boolean(snapshot?.tabs?.length);
  if (hasSnapshot) {
    startupPreserveUntil = Math.max(startupPreserveUntil, Date.now() + 15000);
  }

  let restored = 0;
  const entries = (snapshot?.tabs || []).filter((entry) => byId.has(entry.containerId));
  const hasRestorableEntries = entries.length > 0;
  const consumed = new Set();

  const tabOrder = (a, b) =>
    (windowOrder.get(a.windowId) ?? 0) - (windowOrder.get(b.windowId) ?? 0) ||
    a.index - b.index;
  const entryOrder = (a, b) => (a.window ?? 0) - (b.window ?? 0) || (a.index ?? 0) - (b.index ?? 0);

  const applySnapshotEntry = async (entry, tab) => {
    decided.add(tab.id);
    startupPreservedTabIds.add(tab.id);
    await setTabContainer(tab.id, entry.containerId);
    if (entry.override) await setTabOverride(tab.id, entry.containerId);
    restored += 1;
    consumed.add(entry);
  };

  const entriesByUrl = new Map();
  for (const entry of entries) {
    if (!entry.url) continue;
    const group = entriesByUrl.get(entry.url) || [];
    group.push(entry);
    entriesByUrl.set(entry.url, group);
  }

  for (const [url, group] of entriesByUrl) {
    if (group.length < 2) continue;
    const candidates = tabs
      .filter(
        (tab) =>
          !decided.has(tab.id) &&
          !startupPreservedTabIds.has(tab.id) &&
          snapshotTabUrl(tab) === url
      )
      .sort(tabOrder);
    if (!candidates.length) continue;
    group.sort(entryOrder);

    if (group.length === candidates.length) {
      for (let index = 0; index < group.length; index += 1) {
        await applySnapshotEntry(group[index], candidates[index]);
      }
      continue;
    }

    const pairs = [];
    for (const entry of group) {
      for (const tab of candidates) {
        const entryWindow = entry.window ?? 0;
        const tabWindow = windowOrder.get(tab.windowId) ?? 0;
        pairs.push({
          entry,
          tab,
          distance:
            Math.abs(entryWindow - tabWindow) * 1000 +
            Math.abs((entry.index ?? 0) - tab.index)
        });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);
    const usedEntries = new Set();
    const usedTabs = new Set();
    const target = Math.min(group.length, candidates.length);
    for (const pair of pairs) {
      if (usedEntries.has(pair.entry) || usedTabs.has(pair.tab.id)) continue;
      usedEntries.add(pair.entry);
      usedTabs.add(pair.tab.id);
      await applySnapshotEntry(pair.entry, pair.tab);
      if (usedEntries.size === target) break;
    }
  }

  for (const entry of entries) {
    if (consumed.has(entry)) continue;
    let bestTab = null;
    let bestScore = -1;
    for (const tab of tabs) {
      if (decided.has(tab.id) || startupPreservedTabIds.has(tab.id)) continue;
      const score = snapshotMatchScore(entry, tab, windowOrder);
      if (score > bestScore) {
        bestTab = tab;
        bestScore = score;
      }
    }
    if (!bestTab || bestScore < 0) continue;
    decided.add(bestTab.id);
    startupPreservedTabIds.add(bestTab.id);
    await setTabContainer(bestTab.id, entry.containerId);
    if (entry.override) await setTabOverride(bestTab.id, entry.containerId);
    restored += 1;
  }

  if (settings.groupTabs) {
    const groups = await chrome.tabGroups.query({}).catch(() => []);
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    for (const tab of tabs) {
      if (decided.has(tab.id) || startupPreservedTabIds.has(tab.id) || tab.groupId === -1) {
        continue;
      }
      const group = groupsById.get(tab.groupId);
      const match = containers.find(
        (container) =>
          container.name.trim().toLowerCase() === (group?.title || "").trim().toLowerCase()
      );
      if (!match || match.id === "default") continue;
      decided.add(tab.id);
      startupPreservedTabIds.add(tab.id);
      await setTabContainer(tab.id, match.id);
      restored += 1;
    }
  }

  if (!hasRestorableEntries) {
    const sorted = sortedRules(rules);
    for (const tab of tabs) {
      if (decided.has(tab.id)) continue;
      const domain = getDomain(snapshotTabUrl(tab));
      if (!domain) continue;
      const rule = sorted.find((entry) => hostMatchesRule(domain, entry.domain));
      if (!rule || !byId.has(rule.containerId)) continue;
      decided.add(tab.id);
      await setTabContainer(tab.id, rule.containerId);
      restored += 1;
    }
  }

  if (hasSnapshot) {
    for (const tab of tabs) {
      startupPreservedTabIds.add(tab.id);
      startupNeedsReload.add(tab.id);
    }
  }
  if (restored) await applyAssignmentsToVisuals();
  return restored;
}

async function bootstrap() {
  await ensureSeeded();
  await recoverSwap();
  const containers = await getContainers();
  const meta = await getMeta();
  if (!containers.some((container) => container.id === meta.liveContainerId)) {
    await swapLiveContainer("default");
  }
  await syncLiveJar();
  const map = await getTabMap();
  if (Object.keys(map).length === 0) {
    const snapshot = await getTabRestoreSnapshot();
    if (snapshot) snapshotSuppressedUntil = Date.now() + 10000;
    await restoreStartupAssignments();
  }
  await migrateGroupingDefault();
  await migrateTabEdgeDefault();
  await migrateToolbarBrand();
  await syncAllBurpHeaders();
}

function sortedRules(rules) {
  return [...rules].sort((a, b) => b.domain.length - a.domain.length);
}

async function findRuleForDomain(domain) {
  if (!domain) return null;
  const rules = sortedRules(await getSiteRules());
  return rules.find((rule) => hostMatchesRule(domain, rule.domain)) || null;
}

const SITE_STORAGE_OWNERS_KEY = "siteStorageOwners";
const SITE_STORAGE_PREFIX = "siteStorage:";

function storageOrigin(url) {
  if (!isWebUrl(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function cleanStorageSites(sites) {
  if (!Array.isArray(sites)) return [];
  const cleaned = [];
  for (const site of sites) {
    const domain = normalizeDomain(site);
    if (domain && !cleaned.includes(domain)) cleaned.push(domain);
  }
  return cleaned;
}

async function isStorageIsolated(url) {
  const domain = getDomain(url);
  if (!domain) return false;
  const settings = await getSettings();
  return cleanStorageSites(settings.storageIsolationSites).some((rule) =>
    hostMatchesRule(domain, rule)
  );
}

async function getStorageOwners() {
  const data = await chrome.storage.local.get(SITE_STORAGE_OWNERS_KEY);
  return { ...(data[SITE_STORAGE_OWNERS_KEY] || {}) };
}

async function ensureStorageOwner(origin, fallbackContainerId) {
  if (!origin) return null;
  const owners = await getStorageOwners();
  if (owners[origin]) return owners[origin];
  owners[origin] = fallbackContainerId || "default";
  await chrome.storage.local.set({ [SITE_STORAGE_OWNERS_KEY]: owners });
  return owners[origin];
}

async function readTabLocalStorage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const entries = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key != null) entries[key] = localStorage.getItem(key);
      }
      return entries;
    }
  });
  return result?.result || {};
}

async function writeTabLocalStorage(tabId, entries) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [entries],
    func: (values) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(key, value);
      }
    }
  });
}

async function getSiteStorageSnapshot(origin, containerId) {
  const key = `${SITE_STORAGE_PREFIX}${origin}`;
  const data = await chrome.storage.local.get(key);
  return data[key]?.[containerId] ?? null;
}

async function saveSiteStorageSnapshot(origin, containerId, entries) {
  const key = `${SITE_STORAGE_PREFIX}${origin}`;
  const data = await chrome.storage.local.get(key);
  const snapshots = { ...(data[key] || {}) };
  snapshots[containerId] = entries;
  await chrome.storage.local.set({ [key]: snapshots });
}

const storageSwapQueues = new Map();
const storageReloadPending = new Set();

function withStorageLock(origin, task) {
  const previous = storageSwapQueues.get(origin) || Promise.resolve();
  const run = previous.then(task, task);
  storageSwapQueues.set(origin, run);
  return run.finally(() => {
    if (storageSwapQueues.get(origin) === run) storageSwapQueues.delete(origin);
  });
}

async function storageLoadMatches(tabId, origin, containerId) {
  const load = await getTabStorageLoad(tabId);
  return Boolean(load && load.origin === origin && load.containerId === containerId);
}

async function reloadTabForStorage(tabId, origin, containerId, force = false) {
  if (!force && (await storageLoadMatches(tabId, origin, containerId))) return false;
  if (storageReloadPending.has(tabId)) return false;
  storageReloadPending.add(tabId);
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch {
    storageReloadPending.delete(tabId);
    return false;
  }
}

async function swapSiteStorageLocked(tab, containerId, origin) {
  const owners = await getStorageOwners();
  const owner = owners[origin] || (await getMeta()).liveContainerId || "default";
  if (!owners[origin]) {
    owners[origin] = owner;
    await chrome.storage.local.set({ [SITE_STORAGE_OWNERS_KEY]: owners });
  }
  if (owner === containerId) return false;

  let current;
  try {
    current = await readTabLocalStorage(tab.id);
  } catch {
    return false;
  }
  await saveSiteStorageSnapshot(origin, owner, current);

  const target = await getSiteStorageSnapshot(origin, containerId);
  try {
    await writeTabLocalStorage(tab.id, target || {});
  } catch {
    return false;
  }

  owners[origin] = containerId;
  await chrome.storage.local.set({ [SITE_STORAGE_OWNERS_KEY]: owners });
  return true;
}

async function swapSiteStorage(tab, containerId) {
  if (!tab || tab.id == null || tab.incognito || tab.status !== "complete") return false;
  if (!isWebUrl(tab.url) || !(await isStorageIsolated(tab.url))) return false;
  const origin = storageOrigin(tab.url);
  if (!origin) return false;
  return withStorageLock(origin, () => swapSiteStorageLocked(tab, containerId, origin));
}

async function maybeSwapStorageForActiveTab(tabId) {
  const settings = await getSettings();
  if (settings.autoReload === false || settings.paused) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || tab.status !== "complete" || tab.incognito) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win || !win.focused) return false;
  const containerId = (await getTabContainer(tabId)) || "default";
  const origin = storageOrigin(tab.url);
  const changed = await swapSiteStorage(tab, containerId);
  if (changed && origin) await reloadTabForStorage(tabId, origin, containerId);
  return changed;
}

function containerById(containers, id) {
  return (
    containers.find((container) => container.id === id) ||
    containers.find((container) => container.id === "default")
  );
}

async function buildContentState(tab) {
  const containers = await getContainers();
  const settings = await getSettings();
  const map = await getTabMap();
  const assigned = tab?.id != null ? map[String(tab.id)] || "default" : "default";
  const container = containerById(containers, assigned);
  if (!container) return null;
  return {
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
}

async function pushVisualState(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isWebUrl(tab.url) || tab.incognito) return false;
  const state = await buildContentState(tab);
  if (!state) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "containerVisual", data: state });
    return true;
  } catch {
    // The content script is missing on tabs that predate the extension update.
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/container-visual.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/container-visual.js"]
    });
  } catch {
    return false;
  }
  await chrome.tabs
    .sendMessage(tabId, { type: "containerVisual", data: state })
    .catch(() => {});
  return true;
}

async function refreshTabMarkers() {
  const tabs = await chrome.tabs.query({});
  await mapLimit(tabs, 4, (tab) => pushVisualState(tab.id));
  return true;
}

async function reloadIfFocused(tabId, assigned) {
  const fresh = await chrome.tabs.get(tabId).catch(() => null);
  if (!fresh || !fresh.active || !isWebUrl(fresh.url)) return;
  const win = await chrome.windows.get(fresh.windowId).catch(() => null);
  if (!win || !win.focused) return;
  const loaded = await getTabLoadedJar(tabId);
  if (loaded === assigned) return;
  if (!loaded && fresh.status !== "complete") return;
  await chrome.tabs.reload(tabId).catch(() => {});
}

async function activateTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito) return;
  const containers = await getContainers();
  const settings = await getSettings();
  const assigned = (await getTabContainer(tabId)) || "default";
  const container = containerById(containers, assigned);
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  const focused = Boolean(tab.active && win && win.focused);

  if (settings.paused) {
    await applyTabVisuals(tab, container);
    return;
  }

  if (focused && isWebUrl(tab.url)) {
    const meta = await getMeta();
    const previousLive = meta.liveContainerId || "default";
    const origin = storageOrigin(tab.url);
    const isolated = Boolean(origin && (await isStorageIsolated(tab.url)));
    if (isolated) {
      await ensureStorageOwner(origin, previousLive);
    }
    if (previousLive !== container.id) {
      await swapLiveContainer(container.id);
    }
    const storageChanged =
      isolated && tab.status === "complete"
        ? await swapSiteStorage(tab, container.id)
        : false;
    const storageMismatch =
      isolated && origin && tab.status === "complete"
        ? !(await storageLoadMatches(tabId, origin, container.id))
        : false;

    if (settings.autoReload === false) {
      startupNeedsReload.delete(tabId);
    } else if (startupNeedsReload.has(tabId)) {
      startupNeedsReload.delete(tabId);
      if (isolated) {
        await reloadTabForStorage(tabId, origin, container.id, true);
      } else {
        await chrome.tabs.reload(tabId).catch(() => {});
      }
    } else {
      let storageReloaded = false;
      if (isolated && (storageChanged || storageMismatch)) {
        storageReloaded = await reloadTabForStorage(tabId, origin, container.id);
      }
      if (!storageReloaded) {
        const loaded = await getTabLoadedJar(tabId);
        if (loaded !== container.id) {
          await reloadIfFocused(tabId, container.id);
        }
      }
    }
  }
  await applyTabVisuals(tab, container);
}

function scheduleSwap(tabId) {
  pendingSwapTabId = tabId;
  if (swapBusy || swapTimer) return;
  swapTimer = setTimeout(() => {
    swapTimer = null;
    void runPendingSwap();
  }, 120);
}

async function runPendingSwap() {
  if (swapBusy) return;
  const tabId = pendingSwapTabId;
  pendingSwapTabId = null;
  if (tabId == null) return;
  swapBusy = true;
  try {
    await ready();
    await activateTab(tabId);
  } catch (error) {
    console.error("Container activation failed", error);
  } finally {
    swapBusy = false;
    if (pendingSwapTabId != null && pendingSwapTabId !== tabId) {
      scheduleSwap(pendingSwapTabId);
    } else if (pendingSwapTabId === tabId) {
      pendingSwapTabId = null;
    }
  }
}

async function assignTab(tabId, containerId) {
  const containers = await getContainers();
  const container = containerById(containers, containerId);
  await setTabContainer(tabId, container.id);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await applyTabVisuals(tab, container);
  await syncBurpHeaderForTab(tabId);
  scheduleTabSnapshot();
}

async function handleTabCreated(tab) {
  await ready();
  if (tab.incognito) return;
  const preservedStartup =
    startupPreservedTabIds.has(tab.id) && Date.now() < startupPreserveUntil;
  const containers = await getContainers();
  let containerId = "default";

  const validContainer = (id) => containers.some((container) => container.id === id);
  const override = (await getTabOverrides())[String(tab.id)];
  let resolved = false;

  if (override && validContainer(override.containerId)) {
    containerId = override.containerId;
    resolved = true;
  }

  if (!resolved && !preservedStartup && tab.openerTabId != null) {
    const openerContainerId = await getTabContainer(tab.openerTabId);
    if (openerContainerId && validContainer(openerContainerId)) {
      containerId = openerContainerId;
      resolved = true;
    }
  }

  if (!resolved && !preservedStartup && tab.groupId !== -1) {
    try {
      const group = await chrome.tabGroups.get(tab.groupId);
      const match = containers.find(
        (container) =>
          container.name.trim().toLowerCase() ===
          (group.title || "").trim().toLowerCase()
      );
      if (match) {
        containerId = match.id;
        resolved = true;
      }
    } catch {
      // Group may no longer exist.
    }
  }

  if (!resolved && !preservedStartup) {
    const domain = getDomain(tab.pendingUrl || tab.url);
    if (domain) {
      const rule = await findRuleForDomain(domain);
      if (rule && validContainer(rule.containerId)) {
        containerId = rule.containerId;
      }
    }
  }

  const latestOverride = (await getTabOverrides())[String(tab.id)];
  if (latestOverride && validContainer(latestOverride.containerId)) {
    containerId = latestOverride.containerId;
  } else {
    const current = await getTabContainer(tab.id);
    if (current && current !== "default" && validContainer(current)) {
      containerId = current;
    }
  }

  await assignTab(tab.id, containerId);
  if (tab.active) scheduleSwap(tab.id);
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url) {
    if ((changeInfo.status === "loading" || changeInfo.status === "complete") && !tab.incognito) {
      await ready();
      if (isWebUrl(tab.url)) {
        const meta = await getMeta();
        const live = meta.liveContainerId || "default";
        const assigned = (await getTabContainer(tabId)) || "default";
        const previous = await getTabLoadedJar(tabId);
        if (changeInfo.status === "loading" || !previous) {
          if (assigned === live) {
            await setTabLoadedJar(tabId, live);
          } else {
            await removeTabLoadedJar(tabId);
          }
        }
        const origin = storageOrigin(tab.url);
        if (changeInfo.status === "loading") {
          storageReloadPending.delete(tabId);
          if (origin) await removeTabStorageLoad(tabId);
        } else if (changeInfo.status === "complete" && origin) {
          storageReloadPending.delete(tabId);
          if (await isStorageIsolated(tab.url)) {
            const owners = await getStorageOwners();
            const owner = owners[origin] || meta.liveContainerId || "default";
            await setTabStorageLoad(tabId, origin, owner);
          } else {
            await removeTabStorageLoad(tabId);
          }
        }
      }
      await syncTabVisuals(tabId);
      scheduleTabSnapshot();
      if (changeInfo.status === "complete" && tab.active) {
        await maybeSwapStorageForActiveTab(tabId);
      }
    }
    return;
  }
  await ready();
  if (tab.incognito) return;
  const preservedStartup =
    startupPreservedTabIds.has(tabId) && Date.now() < startupPreserveUntil;

  const containers = await getContainers();
  let containerId = (await getTabContainer(tabId)) || "default";
  if (!containers.some((container) => container.id === containerId)) {
    containerId = "default";
  }

  const domain = getDomain(changeInfo.url);
  let overrideApplied = false;
  const override = (await getTabOverrides())[String(tabId)];
  if (override) {
    const valid = containers.some((container) => container.id === override.containerId);
    if (valid) {
      containerId = override.containerId;
      overrideApplied = true;
    } else {
      await removeTabOverride(tabId);
    }
  }

  if (!overrideApplied && !preservedStartup) {
    const rule = await findRuleForDomain(domain);
    if (rule && containers.some((container) => container.id === rule.containerId)) {
      containerId = rule.containerId;
    }
  }

  const container = containerById(containers, containerId);
  await setTabContainer(tabId, container.id);
  await applyTabVisuals(tab, container);
  await syncBurpHeaderForTab(tabId);
  scheduleTabSnapshot();
  if (tab.active) scheduleSwap(tab.id);
}

async function openTabInContainer({ containerId, url, windowId }) {
  const containers = await getContainers();
  const container = containers.find((item) => item.id === containerId);
  if (!container) throw new Error("Unknown container");
  if (url && !isWebUrl(url)) throw new Error("Only http(s) URLs can be opened in a container");

  const createProperties = { active: false };
  if (Number.isInteger(windowId)) createProperties.windowId = windowId;
  if (url) createProperties.url = "about:blank";

  const tab = await chrome.tabs.create(createProperties);
  await setTabOverride(tab.id, containerId);
  await assignTab(tab.id, containerId);
  const settings = await getSettings();
  if (!settings.paused) {
    const previousLive = (await getMeta()).liveContainerId || "default";
    if (url && (await isStorageIsolated(url))) {
      await ensureStorageOwner(storageOrigin(url), previousLive);
    }
    await swapLiveContainer(containerId);
  }

  if (url) {
    await chrome.tabs.update(tab.id, { url, active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await syncTabVisuals(tab.id);
  scheduleTabSnapshot();

  setTimeout(() => {
    void (async () => {
      const assigned = await getTabContainer(tab.id);
      if (assigned === "default" && containerId !== "default") {
        await assignTab(tab.id, containerId);
        await syncTabVisuals(tab.id);
      }
    })().catch(() => {});
  }, 300);

  return tab.id;
}

async function moveTabToContainer({ tabId, containerId }) {
  const containers = await getContainers();
  const container = containers.find((item) => item.id === containerId);
  if (!container) throw new Error("Unknown container");
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) throw new Error("Containers are not available in incognito windows");

  await setTabOverride(tab.id, containerId);
  await assignTab(tab.id, containerId);
  if (tab.active) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win && win.focused) scheduleSwap(tab.id);
  }
  return { tabId: tab.id, containerId };
}

function cleanContainerInput(input) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Container name is required");
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Container name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  const icon = String(input.icon || "ðŸ“¦").trim().slice(0, MAX_ICON_LENGTH) || "ðŸ“¦";
  const color = COLOR_NAMES.includes(input.color) ? input.color : "blue";
  return { name, icon, color };
}

function assertNameAvailable(containers, name, exceptId = null) {
  const clash = containers.find(
    (container) =>
      container.id !== exceptId &&
      container.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  if (clash) throw new Error(`A container named "${name}" already exists`);
}

async function createContainer(input) {
  const containers = await getContainers();
  const clean = cleanContainerInput(input);
  assertNameAvailable(containers, clean.name);
  const container = { id: newId("c"), ...clean };
  containers.push(container);
  await setContainers(containers);
  await rebuildMenus();
  return container;
}

async function updateContainer({ id, patch }) {
  const containers = await getContainers();
  const existing = containers.find((container) => container.id === id);
  if (!existing) throw new Error("Unknown container");
  if (existing.locked) throw new Error("The Default container cannot be edited");

  const clean = cleanContainerInput({ ...existing, ...patch });
  assertNameAvailable(containers, clean.name, id);
  const oldName = existing.name;

  Object.assign(existing, clean);
  await setContainers(containers);

  if (oldName !== existing.name || patch.color) {
    await nameGroups(oldName, existing.name, existing.color);
  }
  await applyAssignmentsToVisuals();
  await rebuildMenus();
  await syncAllBurpHeaders();
  return existing;
}

async function deleteContainer({ id }) {
  const containers = await getContainers();
  const existing = containers.find((container) => container.id === id);
  if (!existing) throw new Error("Unknown container");
  if (existing.locked) throw new Error("The Default container cannot be deleted");

  const map = await getTabMap();
  const affected = Object.entries(map)
    .filter(([, containerId]) => containerId === id)
    .map(([tabId]) => Number(tabId));
  const defaultContainer = containers.find((container) => container.id === "default");

  await mapLimit(affected, 8, async (tabId) => {
    map[String(tabId)] = "default";
    await removeTabOverride(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await applyTabVisuals(tab, defaultContainer, { forceUngroup: true });
  });
  await setTabMap(map);

  const meta = await getMeta();
  if (meta.liveContainerId === id) {
    await swapLiveContainer("default");
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && isWebUrl(active.url)) {
      await chrome.tabs.reload(active.id).catch(() => {});
    }
  }

  const rules = await getSiteRules();
  await setSiteRules(rules.filter((rule) => rule.containerId !== id));
  await deleteJar(id);
  await setContainers(containers.filter((container) => container.id !== id));
  await rebuildMenus();
  await syncAllBurpHeaders();
  scheduleTabSnapshot();
  return { deleted: id };
}

async function setSiteRule({ domain, containerId }) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) throw new Error("Enter a valid domain, for example example.com");
  const containers = await getContainers();
  if (!containers.some((container) => container.id === containerId)) {
    throw new Error("Unknown container");
  }

  let rules = await getSiteRules();
  rules = rules.filter((rule) => rule.domain !== cleanDomain);
  rules.push({ domain: cleanDomain, containerId, createdAt: Date.now() });
  await setSiteRules(rules);

  return { rules };
}

async function removeSiteRule({ domain }) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) throw new Error("Invalid domain");
  const rules = await getSiteRules();
  const next = rules.filter((rule) => rule.domain !== cleanDomain);
  await setSiteRules(next);
  return { rules: next };
}

async function setSiteStorageIsolation({ domain, enabled }) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) throw new Error("Invalid domain");
  const settings = await getSettings();
  const sites = cleanStorageSites(settings.storageIsolationSites);
  const next = enabled
    ? cleanStorageSites([...sites, cleanDomain])
    : sites.filter((site) => site !== cleanDomain);
  await setSettings({ storageIsolationSites: next });
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) scheduleSwap(active.id);
  return { storageIsolationSites: next };
}

async function setGrouping({ enabled }) {
  return queueSettingsApply(async () => {
    await setSettings({ groupTabs: Boolean(enabled) });
    if (!enabled) await removeContainerGroups();
    await applyAssignmentsToVisuals();
    return getSettings();
  });
}

async function setVisualSettings({ tabMarker, pageEdge, toolbarIcon, burpHeaders, autoReload, paused }) {
  const patch = {};
  if (TAB_MARKERS.includes(tabMarker)) patch.tabMarker = tabMarker;
  if (typeof pageEdge === "boolean") patch.pageEdge = pageEdge;
  if (typeof toolbarIcon === "boolean") patch.toolbarIcon = toolbarIcon;
  if (typeof burpHeaders === "boolean") patch.burpHeaders = burpHeaders;
  if (typeof autoReload === "boolean") patch.autoReload = autoReload;
  if (typeof paused === "boolean") patch.paused = paused;
  if (Object.keys(patch).length === 0) return getSettings();
  return queueSettingsApply(async () => {
    await setSettings(patch);
    await applyAssignmentsToVisuals();
    await refreshTabMarkers();
    if (typeof patch.burpHeaders === "boolean") await syncAllBurpHeaders();
    return getSettings();
  });
}

async function getPopupState({ tabId }) {
  const containers = await getContainers();
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const map = await getTabMap();
  let currentContainerId = tab ? map[String(tab.id)] || "default" : "default";
  if (!containers.some((container) => container.id === currentContainerId)) {
    currentContainerId = "default";
  }
  const domain = tab ? getDomain(tab.url) : null;
  let rule = null;
  if (domain) {
    const rules = sortedRules(await getSiteRules());
    rule = rules.find((entry) => hostMatchesRule(domain, entry.domain)) || null;
  }
  const meta = await getMeta();
  const settings = await getSettings();
  const storageIsolated = domain
    ? cleanStorageSites(settings.storageIsolationSites).some((entry) =>
        hostMatchesRule(domain, entry)
      )
    : false;
  return {
    containers,
    currentContainerId,
    tabId: tab ? tab.id : null,
    domain,
    rule,
    liveContainerId: meta.liveContainerId,
    storageIsolated,
    settings,
    incognito: Boolean(tab && tab.incognito)
  };
}

async function getOptionsState() {
  const [containers, rules, settings, meta] = await Promise.all([
    getContainers(),
    getSiteRules(),
    getSettings(),
    getMeta()
  ]);
  return {
    containers,
    siteRules: sortedRules(rules),
    settings,
    liveContainerId: meta.liveContainerId
  };
}

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const containers = await getContainers();
  for (const kind of ["link", "page"]) {
    const parentId = `containers-parent-${kind}`;
    await chrome.contextMenus.create({
      id: parentId,
      title: kind === "link" ? "Open link in container" : "Open page in container",
      contexts: [kind]
    });
    for (const container of containers) {
      await chrome.contextMenus.create({
        id: `open-${kind}:${container.id}`,
        parentId,
        title: `${container.icon} ${container.name}`,
        contexts: [kind]
      });
    }
  }
}

async function routeMessage(message, sender) {
  switch (message?.type) {
    case "getPopupState":
      return getPopupState(message);
    case "getOptionsState":
      return getOptionsState();
    case "getContentState":
      return buildContentState(sender?.tab || null);
    case "openTabInContainer":
      return { tabId: await openTabInContainer(message) };
    case "moveTabToContainer":
      return moveTabToContainer(message);
    case "createContainer":
      return createContainer(message);
    case "updateContainer":
      return updateContainer(message);
    case "deleteContainer":
      return deleteContainer(message);
    case "setSiteRule":
      return setSiteRule(message);
    case "removeSiteRule":
      return removeSiteRule(message);
    case "setSiteStorageIsolation":
      return setSiteStorageIsolation(message);
    case "setGrouping":
      return setGrouping(message);
    case "setVisualSettings":
      return setVisualSettings(message);
    case "refreshTabMarkers":
      return refreshTabMarkers();
    case "removeContainerGroups":
      return removeContainerGroups();
    case "regroupAll":
      await applyAssignmentsToVisuals();
      return getSettings();
    default:
      throw new Error(`Unknown message type: ${message?.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  void (async () => {
    try {
      await ready();
      const data = await routeMessage(message, sender);
      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ready().then(() => scheduleSwap(tabId)).catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    await ready();
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) scheduleSwap(tab.id);
  })().catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleTabCreated(tab).catch((error) => console.error("onCreated failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab).catch((error) =>
    console.error("onUpdated failed", error)
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  startupPreservedTabIds.delete(tabId);
  startupNeedsReload.delete(tabId);
  storageReloadPending.delete(tabId);
  void removeTabContainer(tabId).catch(() => {});
  void removeTabOverride(tabId).catch(() => {});
  void removeTabLoadedJar(tabId).catch(() => {});
  void removeTabStorageLoad(tabId).catch(() => {});
  void syncBurpHeaderForTab(tabId).catch(() => {});
  scheduleTabSnapshot();
});

chrome.tabs.onAttached.addListener((tabId) => {
  void (async () => {
    await ready();
    await syncTabVisuals(tabId);
    scheduleTabSnapshot();
  })().catch(() => {});
});

chrome.tabs.onMoved.addListener(() => {
  scheduleTabSnapshot();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    await ready();
    const match = /^open-(link|page):(.+)$/.exec(info.menuItemId);
    if (!match) return;
    const url = match[1] === "link" ? info.linkUrl : info.pageUrl;
    if (!isWebUrl(url)) return;
    await openTabInContainer({
      containerId: match[2],
      url,
      windowId: tab?.windowId
    });
  })().catch((error) => console.error("Context menu action failed", error));
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ready();
    await rebuildMenus();
    const containers = await getContainers();
    const meta = await getMeta();
    if (!containers.some((container) => container.id === meta.liveContainerId)) {
      await setMeta({ liveContainerId: "default" });
    }
    await refreshTabMarkers();
  })().catch((error) => console.error("onInstalled failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ready();
    const snapshot = await getTabRestoreSnapshot();
    if (snapshot) {
      snapshotSuppressedUntil = Math.max(snapshotSuppressedUntil, Date.now() + 9000);
    }
    for (const delay of [800, 1500, 2500]) {
      await sleep(delay);
      await restoreStartupAssignments();
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      startupNeedsReload.add(tab.id);
      scheduleSwap(tab.id);
    }
  })().catch((error) => console.error("onStartup failed", error));
});
