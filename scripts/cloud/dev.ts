import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Environment = Readonly<Record<string, string | undefined>>;
type MemoryDatabase = { url: string; token: string; close(): Promise<void> };
export type CloudServer = { url: string; close(): Promise<void> };

export class CloudStartupError extends Error {
  constructor(message: string, readonly cleanupSucceeded: boolean) {
    super(message);
  }
}

/** Next must never automatically load another environment's application secrets. */
export function assertCloudStartupAllowed(environment: Environment, directory = rootDirectory): void {
  if (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined || environment.NODE_ENV === "production") {
    throw new Error("Cloud用サーバーはVercel・Production環境で起動できません。");
  }
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"]) {
    try { lstatSync(join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cloud起動前の環境ファイル確認に失敗しました。");
    }
    throw new Error(`${name} があるため起動できません。既存ファイルを保持し、環境ファイルのない作業先を使ってください。`);
  }
}

/** Retain OS, proxy and CA settings; do not pass application/provider credentials. */
export function isolatedEnvironment(environment: Environment): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DISPLAY",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "PLAYWRIGHT_BROWSERS_PATH", "npm_config_cache", "NPM_CONFIG_CACHE", "TERM", "NO_COLOR", "FORCE_COLOR",
  ]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  for (const key of ["NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY"]) {
    if (environment[key] === "1") result[key] = "1";
  }
  result.PLAYWRIGHT_BROWSERS_PATH ??= resolve(rootDirectory, "../.cache/ms-playwright");
  return result;
}

export function cloudChildEnvironment(environment: Environment, database: Pick<MemoryDatabase, "url" | "token">, url: string): NodeJS.ProcessEnv {
  return {
    ...isolatedEnvironment(environment),
    NODE_ENV: "development", MILLE_DB_MODE: "memory", MILLE_MEMORY_DATABASE_URL: database.url,
    MILLE_MEMORY_DATABASE_TOKEN: database.token, AUTH_MODE: "test", AUTH_SECRET: randomBytes(32).toString("hex"),
    AUTH_URL: url, NEXT_TELEMETRY_DISABLED: "1",
  };
}

export function cloudPort(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value))) {
    throw new Error("portは1〜65535の整数で指定してください。");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error("portは1〜65535の整数で指定してください。");
  return port;
}

export async function assertPortAvailable(port: number, hostname: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`port ${port} を使用できません。別のportを指定してください。`)));
    probe.listen({ port, host: hostname, exclusive: true }, () => probe.close(error => error ? reject(error) : accept()));
  });
}

function terminate(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export function forwardLogs(stream: NodeJS.ReadableStream, target: NodeJS.WritableStream, secrets: readonly string[]): void {
  let pending = "", dropping = false;
  const write = (line: string) => {
    for (const secret of secrets) line = line.replaceAll(secret, "[redacted]");
    line = line.replace(/(\/(?:invite|api\/invitations)\/)[a-f0-9]{64}(?=[/?\s]|$)/g, "$1[redacted]");
    target.write(line);
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (pending.length > 65_536) { pending = ""; dropping = true; }
      if (part.endsWith("\n")) {
        if (!dropping) write(pending);
        pending = ""; dropping = false;
      }
    }
  });
  stream.once("end", () => { if (!dropping && pending) write(pending); });
}

/** Parent-owned, disposable PGlite survives Next worker reloads and is closed with Next. */
export async function startCloudServer({ port: requestedPort, hostname = "0.0.0.0", quiet = false, handleSignals = true }: {
  port?: number; hostname?: "0.0.0.0" | "127.0.0.1"; quiet?: boolean; handleSignals?: boolean;
} = {}): Promise<CloudServer> {
  let port: number;
  try {
    assertCloudStartupAllowed(process.env);
    const expected = readFileSync(join(rootDirectory, ".node-version"), "utf8").trim();
    if (process.version !== `v${expected}`) throw new Error(`Node.js v${expected} を使用してください。`);
    if (process.platform !== "linux") throw new Error("Cloud用サーバーはLinux環境で実行してください。");
    port = cloudPort(requestedPort ?? process.env.PORT ?? 3000);
    await assertPortAvailable(port, hostname);
  } catch (error) {
    throw new CloudStartupError(error instanceof Error ? error.message : "起動条件を確認できません。", true);
  }
  const url = `http://localhost:${port}`;
  let child: ChildProcess | undefined, database: MemoryDatabase | undefined;
  let databasePromise: Promise<MemoryDatabase> | undefined;
  let childExited = false, closing = false;
  let childDone = Promise.resolve(), closePromise: Promise<void> | undefined;
  const exitCleanup = () => terminate(child, "SIGKILL");
  const interrupt = () => { process.exitCode = 130; void close().catch(() => { process.exitCode = 1; }); };
  const terminateSignal = () => { process.exitCode = 143; void close().catch(() => { process.exitCode = 1; }); };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminateSignal);
    closePromise = (async () => {
      try {
        terminate(child, "SIGTERM");
        if (child && !childExited) await Promise.race([childDone, delay(5_000, undefined, { ref: false })]);
        terminate(child, "SIGKILL");
        if (child) await childDone;
      } finally {
        try { await (database ?? await databasePromise)?.close(); }
        finally { process.removeListener("exit", exitCleanup); }
      }
    })();
    return closePromise;
  };
  if (handleSignals) {
    process.once("SIGINT", interrupt); process.once("SIGTERM", terminateSignal);
  }
  process.once("exit", exitCleanup);
  try {
    const { startMemoryDatabase } = await import("./memory-database");
    if (closing) throw new Error("起動を中断しました。");
    databasePromise = startMemoryDatabase();
    database = await databasePromise;
    if (closing) throw new Error("起動を中断しました。");
    assertCloudStartupAllowed(process.env);
    const environment = cloudChildEnvironment(process.env, database, url);
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    child = spawn(process.execPath, [next, "dev", "--hostname", hostname, "--port", String(port)], {
      cwd: rootDirectory, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (quiet) { child.stdout!.resume(); child.stderr!.resume(); }
    else {
      const secrets = [database.token, environment.AUTH_SECRET!];
      forwardLogs(child.stdout!, process.stdout, secrets); forwardLogs(child.stderr!, process.stderr, secrets);
    }
    childDone = new Promise<void>(accept => {
      const stopped = () => {
        childExited = true; accept();
        if (!closing) { process.exitCode = 1; void close().catch(() => { process.exitCode = 1; }); }
      };
      child!.once("error", stopped); child!.once("exit", stopped);
    });
    const deadline = Date.now() + 240_000;
    while (!closing && !childExited && Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        const html = await response.text();
        if (response.status === 200 && html.includes("テストユーザーAでログイン") && html.includes("テストユーザーBでログイン")) {
          if (!closing && !childExited) return { url, close };
        }
      } catch { /* Next may still be compiling the first request. */ }
      await delay(200);
    }
    throw new Error("起動完了を確認できませんでした。");
  } catch (error) {
    let cleanupSucceeded = true;
    await close().catch(() => { cleanupSucceeded = false; });
    throw new CloudStartupError(error instanceof CloudStartupError ? error.message : "Cloud用サーバーを起動できません。起動ログ・port・依存関係を確認してください。", cleanupSucceeded);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--port")) throw new Error("使い方: npm run dev:cloud -- [--port 3000]");
  const server = await startCloudServer({ port: args.length ? cloudPort(args[1]) : undefined });
  console.log(`Mille Cloud: ${server.url}（終了時にメモリDBを破棄します）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : "Cloud起動に失敗しました。");
    process.exitCode = 1;
  });
}
