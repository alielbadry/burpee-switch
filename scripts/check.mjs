import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const manifestPath = path.join(root, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  notes.push("manifest.json parses");
} catch (error) {
  fail(`manifest.json is invalid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!manifest.name) fail("manifest name missing");
if (!manifest.version) fail("manifest version missing");

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {})
].filter(Boolean);

for (const relPath of new Set(referenced)) {
  if (!exists(relPath)) fail(`manifest references missing file: ${relPath}`);
}

const jsFiles = walk(root).filter((file) => file.endsWith(".js"));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe" });
  } catch (error) {
    fail(`syntax error in ${path.relative(root, file)}:\n${error.stderr?.toString() || error.message}`);
  }
}
notes.push(`syntax checked ${jsFiles.length} JavaScript files`);

const iconSizes = new Map([
  ["icons/icon16.png", 16],
  ["icons/icon48.png", 48],
  ["icons/icon128.png", 128]
]);

for (const [relPath, expected] of iconSizes) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    fail(`missing icon: ${relPath}`);
    continue;
  }
  const buffer = fs.readFileSync(full);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  signature.forEach((byte, index) => {
    if (buffer[index] !== byte) fail(`${relPath} is not a valid PNG`);
  });
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expected || height !== expected) {
    fail(`${relPath} is ${width}x${height}, expected ${expected}x${expected}`);
  }
}
notes.push("icons verified as PNG with expected dimensions");

const htmlFiles = walk(root).filter((file) => file.endsWith(".html"));
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    const target = path.resolve(path.dirname(file), ref.split("?")[0]);
    if (!fs.existsSync(target)) {
      fail(`${path.relative(root, file)} references missing ${ref}`);
    }
  }
}
notes.push(`checked local references in ${htmlFiles.length} HTML files`);

for (const extra of ["README.md", "lib/constants.js", "lib/store.js", "lib/jars.js", "lib/groups.js", "lib/util.js"]) {
  if (!exists(extra)) fail(`missing expected file: ${extra}`);
}

if (failures.length) {
  console.error("FAIL");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("PASS");
for (const note of notes) console.log(` - ${note}`);
