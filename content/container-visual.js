(() => {
  if (window.__containerVisualCleanup) {
    try {
      window.__containerVisualCleanup();
    } catch {
      // Previous instance is already gone.
    }
  }

  const EMOJI = {
    grey: "⚫",
    blue: "🔵",
    red: "🔴",
    yellow: "🟡",
    green: "🟢",
    pink: "🩷",
    purple: "🟣",
    cyan: "🩵",
    orange: "🟠"
  };
  const TILE_FONT = '700 34px Arial, Helvetica, sans-serif';
  const BADGE_FONT = '700 24px Arial, Helvetica, sans-serif';
  const EDGE_ID = "container-page-edge";

  let state = null;
  let markerLink = null;
  let originalIcons = new Map();
  let currentPrefix = "";
  let suppressTitle = false;
  let headObserver = null;
  let titleObserver = null;
  let edgeHost = null;
  let applying = false;
  let renderToken = 0;
  let headTimer = null;
  let titleTimer = null;

  const head = () => document.head || document.documentElement;

  function initialOf(name) {
    const chars = Array.from(String(name || "").trim());
    return (chars[0] || "?").toUpperCase();
  }

  function isDefault(container) {
    return !container || container.id === "default";
  }

  function stopHeadObserver() {
    if (headObserver) {
      headObserver.disconnect();
      headObserver = null;
    }
    if (headTimer) {
      clearTimeout(headTimer);
      headTimer = null;
    }
  }

  function stopTitleObserver() {
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
    if (titleTimer) {
      clearTimeout(titleTimer);
      titleTimer = null;
    }
  }

  function restoreOriginalIcons() {
    for (const [link, rel] of originalIcons) {
      if (link.isConnected) link.setAttribute("rel", rel);
    }
    originalIcons.clear();
  }

  function collectOriginalIcons() {
    document.querySelectorAll('link[rel~="icon"]').forEach((link) => {
      if (link === markerLink || link.id === "container-marker-icon") return;
      if (!originalIcons.has(link)) {
        originalIcons.set(link, link.getAttribute("rel") || "icon");
      }
      link.setAttribute("rel", "container-disabled-icon");
    });
  }

  function clearFavicon() {
    renderToken += 1;
    stopHeadObserver();
    if (markerLink) {
      markerLink.remove();
      markerLink = null;
    }
    restoreOriginalIcons();
  }

  function ensureMarkerLink() {
    if (markerLink && markerLink.isConnected) return;
    markerLink = document.createElement("link");
    markerLink.id = "container-marker-icon";
    markerLink.rel = "icon";
    markerLink.type = "image/png";
    head().appendChild(markerLink);
  }

  function siteIconUrl() {
    for (const link of originalIcons.keys()) {
      if (link.href) return link.href;
    }
    const current = document.querySelector(
      'link[rel~="icon"]:not(#container-marker-icon)'
    );
    if (current && current.href) return current.href;
    try {
      return new URL("/favicon.ico", location.href).href;
    } catch {
      return null;
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => reject(new Error("favicon timeout")), 1600);
      image.crossOrigin = "anonymous";
      image.onload = () => {
        clearTimeout(timer);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error("favicon load failed"));
      };
      image.src = url;
    });
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function tileData(container) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = container.hex || "#5f6368";
    roundedRect(ctx, 0, 0, 64, 64, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = TILE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initialOf(container.name), 32, 34);
    return canvas.toDataURL("image/png");
  }

  async function dotData(container, token) {
    const url = siteIconUrl();
    let image = null;
    if (url) {
      image = await loadImage(url).catch(() => null);
    }
    if (token !== renderToken) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, 64, 64);

    if (image && image.width && image.height) {
      const scale = Math.min(64 / image.width, 64 / image.height);
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      try {
        ctx.drawImage(image, Math.round((64 - width) / 2), Math.round((64 - height) / 2), width, height);
      } catch {
        image = null;
      }
    }

    if (!image) {
      ctx.beginPath();
      ctx.arc(32, 32, 30, 0, Math.PI * 2);
      ctx.fillStyle = "#e8eaed";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(48, 48, 18, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(48, 48, 14, 0, Math.PI * 2);
    ctx.fillStyle = container.hex || "#5f6368";
    ctx.fill();

    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  async function badgeData(container, token) {
    const url = siteIconUrl();
    let image = null;
    if (url) {
      image = await loadImage(url).catch(() => null);
    }
    if (token !== renderToken) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, 64, 64);

    if (image && image.width && image.height) {
      const scale = Math.min(64 / image.width, 64 / image.height);
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      try {
        ctx.drawImage(image, Math.round((64 - width) / 2), Math.round((64 - height) / 2), width, height);
      } catch {
        image = null;
      }
    }

    if (!image) {
      ctx.beginPath();
      ctx.arc(32, 32, 30, 0, Math.PI * 2);
      ctx.fillStyle = "#e8eaed";
      ctx.fill();
    }

    ctx.fillStyle = "#ffffff";
    roundedRect(ctx, 27, 27, 40, 40, 13);
    ctx.fill();
    ctx.fillStyle = container.hex || "#5f6368";
    roundedRect(ctx, 30, 30, 34, 34, 10);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = BADGE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initialOf(container.name), 47, 48);

    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  function startHeadObserver() {
    if (headObserver) return;
    headObserver = new MutationObserver(() => {
      if (applying || !state) return;
      if (
        state.marker !== "favicon-dot" &&
        state.marker !== "favicon-tile" &&
        state.marker !== "favicon-title"
      ) {
        return;
      }
      clearTimeout(headTimer);
      headTimer = setTimeout(() => {
        if (applying || !state) return;
        if (
          state.marker !== "favicon-dot" &&
          state.marker !== "favicon-tile" &&
          state.marker !== "favicon-title"
        ) {
          return;
        }
        const mode =
          state.marker === "favicon-tile"
            ? "favicon-tile"
            : state.marker === "favicon-title"
              ? "favicon-badge"
              : "favicon-dot";
        void renderFavicon(mode, state.container);
      }, 80);
    });
    try {
      headObserver.observe(head(), {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["rel", "href"]
      });
    } catch {
      headObserver = null;
    }
  }

  async function renderFavicon(mode, container) {
    if (!container) return;
    const token = ++renderToken;
    applying = true;
    collectOriginalIcons();
    ensureMarkerLink();
    if (!markerLink) {
      applying = false;
      return;
    }
    try {
      let data =
        mode === "favicon-tile"
          ? tileData(container)
          : mode === "favicon-badge"
            ? await badgeData(container, token)
            : await dotData(container, token);
      if (!data && token === renderToken) data = tileData(container);
      if (token !== renderToken || !data || !markerLink) return;
      markerLink.href = data;
      head().appendChild(markerLink);
    } finally {
      setTimeout(() => {
        if (token === renderToken) applying = false;
      }, 120);
    }
  }

  function restoreTitle() {
    stopTitleObserver();
    if (!currentPrefix) return;
    const current = document.title;
    if (current.startsWith(currentPrefix)) {
      suppressTitle = true;
      document.title = current.slice(currentPrefix.length);
      suppressTitle = false;
    }
    currentPrefix = "";
  }

  function setTitlePrefix(prefix) {
    const current = document.title;
    let base = current;
    if (currentPrefix && base.startsWith(currentPrefix)) {
      base = base.slice(currentPrefix.length);
    }
    currentPrefix = prefix;
    if (!base.trim()) return;
    if (base.startsWith(prefix)) return;
    suppressTitle = true;
    document.title = prefix + base;
    suppressTitle = false;
  }

  function setTitleMarker(container) {
    setTitlePrefix(`${EMOJI[container.color] || "⬜"} `);
  }

  function setTitleName(container) {
    setTitlePrefix(`[${container.name || "Container"}] `);
  }

  function reapplyTitle() {
    if (!state || isDefault(state.container)) return;
    if (state.marker === "title-emoji") setTitleMarker(state.container);
    else if (state.marker === "favicon-title") setTitleName(state.container);
  }

  function startTitleObserver() {
    if (titleObserver) return;
    titleObserver = new MutationObserver(() => {
      if (suppressTitle || !state) return;
      if (state.marker !== "title-emoji" && state.marker !== "favicon-title") return;
      if (isDefault(state.container)) return;
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => {
        if (
          state?.marker === "title-emoji" ||
          state?.marker === "favicon-title"
        ) {
          reapplyTitle();
        }
      }, 40);
    });
    try {
      titleObserver.observe(head(), {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch {
      titleObserver = null;
    }
  }

  function applyMarker(mode, container) {
    if (mode === "title-emoji") {
      clearFavicon();
      setTitleMarker(container);
      startTitleObserver();
      return;
    }
    if (mode === "favicon-title") {
      void renderFavicon("favicon-badge", container);
      setTitleName(container);
      startHeadObserver();
      startTitleObserver();
      return;
    }
    if (mode === "favicon-dot" || mode === "favicon-tile") {
      restoreTitle();
      void renderFavicon(mode, container);
      startHeadObserver();
      return;
    }
    clearFavicon();
    restoreTitle();
  }

  function clearEdge() {
    if (edgeHost) {
      edgeHost.remove();
      edgeHost = null;
    }
    const stale = document.getElementById(EDGE_ID);
    if (stale) stale.remove();
  }

  function applyEdge(enabled, container) {
    if (!enabled || !container) {
      clearEdge();
      return;
    }
    if (!edgeHost || !edgeHost.isConnected) {
      clearEdge();
      edgeHost = document.createElement("div");
      edgeHost.id = EDGE_ID;
      edgeHost.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "ce-label";
      edgeHost.appendChild(label);
      (document.documentElement || document.body).appendChild(edgeHost);
    }
    const color = /^[a-z]+$/.test(container.color || "") ? container.color : "grey";
    edgeHost.className = `ce-color-${color}`;
    const label = edgeHost.querySelector(".ce-label");
    if (label) label.textContent = container.name || "";
  }

  function apply(next) {
    if (!next) return;
    state = next;
    const container = next.container;
    const off = isDefault(container);
    const marker = off ? "off" : next.marker;
    applyMarker(marker, container);
    applyEdge(!off && Boolean(next.pageEdge), container);
  }

  function cleanup() {
    clearFavicon();
    restoreTitle();
    clearEdge();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context was invalidated.
    }
    state = null;
    if (window.__containerVisualCleanup === cleanup) {
      delete window.__containerVisualCleanup;
    }
  }

  function onMessage(message) {
    if (message?.type === "containerVisual") apply(message.data);
  }

  async function init() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "getContentState" });
        if (response?.ok) {
          apply(response.data);
          return;
        }
      } catch {
        // Service worker may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.__containerVisualCleanup = cleanup;
  void init();
})();
