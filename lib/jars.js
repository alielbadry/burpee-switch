import { getJar, getMeta, setJar, setMeta } from "./store.js";
import { cookieUrl, mapLimit } from "./util.js";

let cachedStoreId = null;
let swapQueue = Promise.resolve();

export async function getDefaultStoreId() {
  if (cachedStoreId) return cachedStoreId;
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const normal =
      stores.find((store) => store.id === "0") ||
      stores.find((store) => Array.isArray(store.tabIds) && store.tabIds.length > 0) ||
      stores[0];
    cachedStoreId = normal?.id || "0";
  } catch {
    cachedStoreId = "0";
  }
  return cachedStoreId;
}

function serializeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || "unspecified",
    expirationDate: cookie.expirationDate,
    hostOnly: Boolean(cookie.hostOnly)
  };
}

export async function snapshotLiveJar() {
  const storeId = await getDefaultStoreId();
  const cookies = await chrome.cookies.getAll({ storeId });
  const now = Date.now();
  return cookies
    .filter((cookie) => !cookie.partitionKey)
    .filter((cookie) => !cookie.expirationDate || cookie.expirationDate * 1000 > now)
    .map(serializeCookie);
}

export async function clearLiveJar() {
  const storeId = await getDefaultStoreId();
  const cookies = await chrome.cookies.getAll({ storeId });
  await mapLimit(cookies, 12, async (cookie) => {
    try {
      await chrome.cookies.remove({
        url: cookieUrl(cookie),
        name: cookie.name,
        storeId
      });
    } catch (error) {
      console.warn("Failed to remove cookie", cookie.domain, cookie.name, error);
    }
  });
}

export async function restoreJar(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  const storeId = await getDefaultStoreId();
  await mapLimit(cookies, 8, async (cookie) => {
    const details = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || "unspecified",
      storeId
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    try {
      await chrome.cookies.set(details);
    } catch (error) {
      console.warn("Failed to restore cookie", cookie.domain, cookie.name, error);
    }
  });
}

async function performRecover() {
  const meta = await getMeta();
  const marker = meta.swap;
  if (!marker || !marker.to) return false;
  console.warn("Recovering interrupted cookie jar swap", marker);
  await clearLiveJar();
  const target = await getJar(marker.to);
  if (target) await restoreJar(target);
  await setMeta({ liveContainerId: marker.to, swap: null });
  return true;
}

async function performSwap(targetId) {
  await performRecover();
  const meta = await getMeta();
  if (meta.liveContainerId === targetId) return false;

  const from = meta.liveContainerId || "default";
  const snapshot = await snapshotLiveJar();
  await setJar(from, snapshot);
  await setMeta({
    liveContainerId: from,
    swap: { from, to: targetId, at: Date.now() }
  });

  await clearLiveJar();
  const target = await getJar(targetId);
  if (target && target.length) await restoreJar(target);

  await setMeta({ liveContainerId: targetId, swap: null });
  return true;
}

function enqueue(task) {
  const run = swapQueue.then(task, task);
  swapQueue = run.catch(() => {});
  return run;
}

export function recoverSwap() {
  return enqueue(performRecover);
}

export function syncLiveJar() {
  return enqueue(async () => {
    const meta = await getMeta();
    if (meta.swap) return;
    const live = meta.liveContainerId || "default";
    const snapshot = await snapshotLiveJar();
    await setJar(live, snapshot);
  });
}

export function swapLiveContainer(targetId) {
  return enqueue(() => performSwap(targetId));
}
