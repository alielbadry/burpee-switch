export function newId(prefix = "c") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

export function isRestrictedUrl(url) {
  return typeof url === "string" && /^(chrome|chrome-extension|devtools|edge|about|view-source):/i.test(url);
}

export function getDomain(url) {
  if (!isWebUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeDomain(domain) {
  if (typeof domain !== "string") return null;
  const value = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (!value || value.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (value.includes("..")) return null;
  return value;
}

export function hostMatchesRule(host, ruleDomain) {
  if (!host || !ruleDomain) return false;
  return host === ruleDomain || host.endsWith(`.${ruleDomain}`);
}

export function cookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  let path = cookie.path || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return `${cookie.secure ? "https" : "http"}://${host}${path}`;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export function firstChar(value) {
  if (!value) return "?";
  const chars = Array.from(value.trim());
  return (chars[0] || "?").toUpperCase();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
