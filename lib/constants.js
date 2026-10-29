export const STORAGE_KEYS = {
  containers: "containers",
  siteRules: "siteRules",
  settings: "settings",
  meta: "meta",
  jarPrefix: "jar:",
  tabContainers: "tabContainers",
  tabRestore: "tabRestoreSnapshot"
};

export const DEFAULT_CONTAINERS = [
  { id: "default", name: "Default", color: "grey", icon: "🌐", locked: true },
  { id: "personal", name: "Personal", color: "blue", icon: "👤" },
  { id: "work", name: "Work", color: "red", icon: "💼" },
  { id: "banking", name: "Banking", color: "purple", icon: "🏦" },
  { id: "shopping", name: "Shopping", color: "green", icon: "🛒" }
];

export const COLORS = {
  grey: { hex: "#5f6368", label: "Grey" },
  blue: { hex: "#1a73e8", label: "Blue" },
  red: { hex: "#d93025", label: "Red" },
  yellow: { hex: "#f9ab00", label: "Yellow" },
  green: { hex: "#188038", label: "Green" },
  pink: { hex: "#d01884", label: "Pink" },
  purple: { hex: "#9334e6", label: "Purple" },
  cyan: { hex: "#007b83", label: "Cyan" },
  orange: { hex: "#e8710a", label: "Orange" }
};

export const COLOR_NAMES = Object.keys(COLORS);

export const TAB_MARKERS = [
  "off",
  "favicon-dot",
  "favicon-tile",
  "title-emoji",
  "favicon-title"
];

export const DEFAULT_SETTINGS = {
  groupTabs: false,
  tabMarker: "favicon-dot",
  pageEdge: true,
  toolbarIcon: false,
  burpHeaders: false,
  autoReload: true,
  paused: false,
  storageIsolationSites: []
};

export const MAX_NAME_LENGTH = 24;
export const MAX_ICON_LENGTH = 8;
