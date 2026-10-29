import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeInstallEnvironment, syncDependencies } from "./dependencies.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const environment = safeInstallEnvironment();
environment.PLAYWRIGHT_BROWSERS_PATH ??= resolve(directory, "../.cache/ms-playwright");
environment.NEXT_TELEMETRY_DISABLED = "1";

async function execute(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: directory, env: environment, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
    const cleanup = () => { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); };
    child.once("error", () => { cleanup(); reject(new Error(`${command} を実行できませんでした。`)); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0 && !signal) accept();
      else reject(new Error(`${command} が正常終了しませんでした。`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--with-deps")) throw new Error("使い方: npm run setup:cloud -- [--with-deps]");
  if (process.platform !== "linux") throw new Error("setup:cloud はLinux環境専用です。");
  syncDependencies(directory);
  await execute("npx", ["--no-install", "playwright", "install", ...(args.length ? ["--with-deps"] : []), "chromium"]);
  console.log("Mille Cloud: 依存関係と公式Playwright Chromiumを準備しました。");
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Cloud準備に失敗しました。");
  process.exitCode = 1;
});
