import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const receiptName = ".mille-dependencies.json";
const protocol = "mille-dependencies/v1";

/**
 * Keep the setup script's OS, cache, proxy and CA settings, never provider credentials or execution hooks.
 * @param {Readonly<Record<string, string | undefined>>} [environment]
 */
export function safeInstallEnvironment(environment = process.env) {
  const result = Object.fromEntries([
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY", "npm_config_cache", "NPM_CONFIG_CACHE", "PLAYWRIGHT_BROWSERS_PATH",
  ].flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]]));
  result.PLAYWRIGHT_BROWSERS_PATH ??= resolve(rootDirectory, "../.cache/ms-playwright");
  result.NEXT_TELEMETRY_DISABLED = "1";
  return result;
}

function stat(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function inputSnapshot(directory) {
  const files = {};
  let pinnedNode;
  for (const name of ["package.json", "package-lock.json", ".node-version"]) {
    const path = join(directory, name);
    if (!stat(path)?.isFile()) throw new Error("依存定義は通常ファイルで用意してください。");
    const bytes = readFileSync(path);
    files[name] = createHash("sha256").update(bytes).digest("hex");
    if (name === ".node-version") pinnedNode = bytes.toString("utf8").trim();
  }
  const runtime = { node: process.version, platform: process.platform, arch: process.arch };
  return { fingerprint: createHash("sha256").update(JSON.stringify({ protocol, files, ...runtime })).digest("hex"), pinnedNode, ...runtime };
}

/** Read-only freshness check. Missing/invalid evidence never establishes a successful installation. */
export function dependencyStatus(directory) {
  try {
    const current = inputSnapshot(resolve(directory));
    const modules = join(directory, "node_modules");
    if (!stat(modules)?.isDirectory()) return { state: "unknown", reason: "node_modulesがありません。", fingerprint: current.fingerprint };
    const receiptPath = join(modules, receiptName);
    if (!stat(receiptPath)?.isFile()) return { state: "unknown", reason: "依存導入の成功記録がありません。", fingerprint: current.fingerprint };
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt?.protocol !== protocol || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) {
      return { state: "unknown", reason: "依存導入の成功記録を確認できません。", fingerprint: current.fingerprint };
    }
    if (receipt.fingerprint !== current.fingerprint || receipt.node !== current.node
      || receipt.platform !== current.platform || receipt.arch !== current.arch) {
      return { state: "stale", reason: "依存定義または実行環境が導入時から変わっています。", fingerprint: current.fingerprint };
    }
    return { state: "ready", reason: "現在の依存定義・Node・platform・archでの導入記録を確認しました。", fingerprint: current.fingerprint };
  } catch {
    return { state: "unknown", reason: "依存定義または導入記録を読み取れません。" };
  }
}

function npmCi(directory, environment) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
    cwd: directory, env: environment, stdio: "inherit", shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error("npm ci が正常終了しませんでした。");
}

function removeReceipt(path) {
  try { unlinkSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

/**
 * Refresh dependencies and record evidence only after npm ci succeeds.
 * The injectable installer has the same contract as npmCi: return normally on success, throw on failure.
 * @param {string} directory
 * @param {{install?: (directory: string, environment: Record<string, string | undefined>) => void}} [options]
 */
export function syncDependencies(directory, { install = npmCi } = {}) {
  const target = resolve(directory);
  const before = inputSnapshot(target);
  if (!/^\d+\.\d+\.\d+$/.test(before.pinnedNode ?? "") || process.version !== `v${before.pinnedNode}`) {
    throw new Error(".node-versionと同じ完全版のNode.jsを使用してください。");
  }
  const modules = join(target, "node_modules"), receiptPath = join(modules, receiptName);
  const modulesStat = stat(modules);
  if (modulesStat && !modulesStat.isDirectory()) throw new Error("node_modulesはこのcheckout内の通常ディレクトリを使ってください。");
  // Invalidate before running npm: a failed refresh cannot retain prior ready evidence.
  removeReceipt(receiptPath);
  install(target, safeInstallEnvironment());
  if (!stat(modules)?.isDirectory()) throw new Error("npm ci後のnode_modulesを確認できません。");
  const after = inputSnapshot(target);
  if (before.fingerprint !== after.fingerprint) throw new Error("依存導入中に依存定義が変更されたため記録しません。");
  const temporaryPath = join(modules, `${receiptName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor, created = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600); created = true;
    writeFileSync(descriptor, JSON.stringify({ protocol, fingerprint: after.fingerprint,
      node: after.node, platform: after.platform, arch: after.arch }, null, 2) + "\n");
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporaryPath, receiptPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) removeReceipt(temporaryPath);
  }
  return dependencyStatus(target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "install") throw new Error("使い方: node scripts/cloud/dependencies.mjs install");
    const result = syncDependencies(rootDirectory);
    if (result.state !== "ready") throw new Error("依存導入の成功記録を確認できません。");
    console.log("Mille: 現在の依存定義・実行環境でnpm ciを完了しました。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "依存導入を完了できませんでした。");
    process.exitCode = 1;
  }
}
