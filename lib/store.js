import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  STORAGE_KEYS
} from "./constants.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function ensureSeeded() {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.containers);
  if (!Array.isArray(existing[STORAGE_KEYS.containers])) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.containers]: clone(DEFAULT_CONTAINERS)
    });
  }
  const settings = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!settings[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: clone(DEFAULT_SETTINGS)
    });
  }
  const meta = await chrome.storage.local.get(STORAGE_KEYS.meta);
  if (!meta[STORAGE_KEYS.meta]?.liveContainerId) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.meta]: {
        ...(meta[STORAGE_KEYS.meta] || {}),
        liveContainerId: "default"
      }
    });
  }
}

export async function getContainers() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.containers);
  const containers = data[STORAGE_KEYS.containers];
  return Array.isArray(containers) ? containers : clone(DEFAULT_CONTAINERS);
}

export async function setContainers(containers) {
  await chrome.storage.local.set({ [STORAGE_KEYS.containers]: containers });
}

export async function getContainer(id) {
  const containers = await getContainers();
  return containers.find((container) => container.id === id) || null;
}

export async function getSiteRules() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.siteRules);
  return Array.isArray(data[STORAGE_KEYS.siteRules]) ? data[STORAGE_KEYS.siteRules] : [];
}

export async function setSiteRules(rules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.siteRules]: rules });
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

export async function setSettings(patch) {
  const settings = await getSettings();
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getMeta() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
  return { liveContainerId: "default", ...(data[STORAGE_KEYS.meta] || {}) };
}

export async function setMeta(patch) {
  const meta = await getMeta();
  const next = { ...meta, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.meta]: next });
  return next;
}

export async function getJar(containerId) {
  const key = `${STORAGE_KEYS.jarPrefix}${containerId}`;
  const data = await chrome.storage.local.get(key);
  return Array.isArray(data[key]) ? data[key] : null;
}

export async function setJar(containerId, cookies) {
  const key = `${STORAGE_KEYS.jarPrefix}${containerId}`;
  await chrome.storage.local.set({ [key]: cookies });
}

export async function deleteJar(containerId) {
  await chrome.storage.local.remove(`${STORAGE_KEYS.jarPrefix}${containerId}`);
}

let sessionWriteQueue = Promise.resolve();

function enqueueSessionWrite(task) {
  const run = sessionWriteQueue.then(task, task);
  sessionWriteQueue = run.catch(() => {});
  return run;
}

async function writeTabMap(map) {
  await chrome.storage.session.set({ [STORAGE_KEYS.tabContainers]: map });
}

async function writeTabOverrides(overrides) {
  await chrome.storage.session.set({ tabOverrides: overrides });
}

export async function getTabMap() {
  const data = await chrome.storage.session.get(STORAGE_KEYS.tabContainers);
  return data[STORAGE_KEYS.tabContainers] || {};
}

export function setTabMap(map) {
  return enqueueSessionWrite(() => writeTabMap(map));
}

export async function getTabContainer(tabId) {
  const map = await getTabMap();
  return map[String(tabId)] || null;
}

export function setTabContainer(tabId, containerId) {
  return enqueueSessionWrite(async () => {
    const map = await getTabMap();
    map[String(tabId)] = containerId;
    await writeTabMap(map);
  });
}

export function removeTabContainer(tabId) {
  return enqueueSessionWrite(async () => {
    const map = await getTabMap();
    if (map[String(tabId)] === undefined) return;
    delete map[String(tabId)];
    await writeTabMap(map);
  });
}

async function getLoadedJarMap() {
  const data = await chrome.storage.session.get("tabLoadedJars");
  return data.tabLoadedJars || {};
}

export async function getTabLoadedJar(tabId) {
  const map = await getLoadedJarMap();
  return map[String(tabId)] || null;
}

export function setTabLoadedJar(tabId, containerId) {
  return enqueueSessionWrite(async () => {
    const map = await getLoadedJarMap();
    map[String(tabId)] = containerId;
    await chrome.storage.session.set({ tabLoadedJars: map });
  });
}

export function removeTabLoadedJar(tabId) {
  return enqueueSessionWrite(async () => {
    const map = await getLoadedJarMap();
    if (map[String(tabId)] === undefined) return;
    delete map[String(tabId)];
    await chrome.storage.session.set({ tabLoadedJars: map });
  });
}

async function getStorageLoadMap() {
  const data = await chrome.storage.session.get("tabStorageLoads");
  return data.tabStorageLoads || {};
}

export async function getTabStorageLoad(tabId) {
  const map = await getStorageLoadMap();
  return map[String(tabId)] || null;
}

export function setTabStorageLoad(tabId, origin, containerId) {
  return enqueueSessionWrite(async () => {
    const map = await getStorageLoadMap();
    map[String(tabId)] = { origin, containerId };
    await chrome.storage.session.set({ tabStorageLoads: map });
  });
}

export function removeTabStorageLoad(tabId) {
  return enqueueSessionWrite(async () => {
    const map = await getStorageLoadMap();
    if (map[String(tabId)] === undefined) return;
    delete map[String(tabId)];
    await chrome.storage.session.set({ tabStorageLoads: map });
  });
}

export async function getTabOverrides() {
  const data = await chrome.storage.session.get("tabOverrides");
  return data.tabOverrides || {};
}

export function setTabOverride(tabId, containerId) {
  return enqueueSessionWrite(async () => {
    const overrides = await getTabOverrides();
    overrides[String(tabId)] = { containerId };
    await writeTabOverrides(overrides);
  });
}

export function removeTabOverride(tabId) {
  return enqueueSessionWrite(async () => {
    const overrides = await getTabOverrides();
    if (overrides[String(tabId)] === undefined) return;
    delete overrides[String(tabId)];
    await writeTabOverrides(overrides);
  });
}

export async function getTabRestoreSnapshot() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.tabRestore);
  const snapshot = data[STORAGE_KEYS.tabRestore];
  return snapshot && Array.isArray(snapshot.tabs) ? snapshot : null;
}

export async function setTabRestoreSnapshot(snapshot) {
  await chrome.storage.local.set({ [STORAGE_KEYS.tabRestore]: snapshot });
}
