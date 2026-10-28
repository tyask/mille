import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import { TEST_USERS } from "../../lib/shared/test-users";
import { CloudStartupError, cloudPort, isolatedEnvironment, rootDirectory, startCloudServer, type CloudServer } from "./dev";

// Playwright resolves its executable registry on import, before launch({ env }) applies.
// Keep this process's lookup aligned with setup:cloud and preserve an explicit override.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(rootDirectory, "../.cache/ms-playwright");

const executeFile = promisify(execFile);
type Source = { sha: string; branch: string; clean: boolean };
type CheckCase = {
  name: string; userKey: string; mobile: boolean; status: "not-run" | "running" | "passed" | "failed";
  checks: string[]; screenshots: string[]; durationMs: number;
  history?: { restoredFromCache: boolean };
};
export type BrowserProof = {
  protocol: "mille-browser/v1"; success: boolean; startedAt: string; finishedAt: string; durationMs: number;
  source: { before: Source | null; after: Source | null; unchanged: boolean };
  target: { kind: "local" | "preview"; origin: string | null; expectedSha: string | null; runtimeSha: string | null };
  environment: { platform: string; node: string; chromium: string | null };
  cases: CheckCase[]; failure?: { stage: string; case?: string };
  resources: { browserContexts: number; browsers: number; servers: number | null; databases: number | null };
};

export function previewOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app") || url.username || url.password
    || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MILLE_QA_BASE_URLには専用Vercel PreviewのHTTPS originを指定してください。");
  }
  return url.origin;
}

/** The protection capability must never follow a redirect to another origin. */
export function scopedProtectionHeaders(requestUrl: string, origin: string, secret?: string): Record<string, string> {
  return secret && new URL(requestUrl).origin === origin ? { "x-vercel-protection-bypass": secret } : {};
}

export function sourceUnchanged(before: Source | null, after: Source | null): boolean {
  return Boolean(before && after && before.sha === after.sha && before.branch === after.branch && before.clean && after.clean);
}

async function source(): Promise<Source> {
  const options = { cwd: rootDirectory, env: isolatedEnvironment(process.env), timeout: 15_000, maxBuffer: 1024 * 1024 };
  const [sha, branch, status] = await Promise.all([
    executeFile("git", ["rev-parse", "HEAD"], options),
    executeFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], options),
    executeFile("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal"], options),
  ]);
  if (!/^[a-f0-9]{40}$/.test(sha.stdout.trim()) || !branch.stdout.trim()) throw new Error("SOURCE_INVALID");
  return { sha: sha.stdout.trim(), branch: branch.stdout.trim(), clean: status.stdout.length === 0 };
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error("BROWSER_CHECK_FAILED");
}

async function readIdentity(page: Page, path = "/api/me") {
  return page.evaluate(async target => {
    const response = await fetch(target, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }, path);
}

export async function verifyBrowser(args: readonly string[] = []): Promise<BrowserProof> {
  const directory = resolve(rootDirectory, ".mille/cloud"), proofPath = resolve(directory, "verification.json");
  const started = Date.now();
  const proof: BrowserProof = {
    protocol: "mille-browser/v1", success: false, startedAt: new Date(started).toISOString(), finishedAt: "", durationMs: 0,
    source: { before: null, after: null, unchanged: false },
    target: { kind: process.env.MILLE_QA_BASE_URL ? "preview" : "local", origin: null, expectedSha: null, runtimeSha: null },
    environment: { platform: process.platform, node: process.version, chromium: null },
    cases: [false, true].flatMap(mobile => TEST_USERS.map(user => ({
      name: `${mobile ? "mobile" : "desktop"}-${user.key}`, userKey: user.key, mobile,
      status: "not-run" as const, checks: [], screenshots: [], durationMs: 0,
    }))),
    resources: { browserContexts: 0, browsers: 0, servers: 0, databases: 0 },
  };
  let stage = "proof", currentCase: CheckCase | undefined;
  let server: CloudServer | undefined, browser: Browser | undefined;
  let interrupted = false;
  const contexts = new Set<BrowserContext>();
  const interrupt = () => { interrupted = true; void browser?.close().catch(() => undefined); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const fail = (failureStage: string) => {
    proof.failure ??= { stage: failureStage, ...(currentCase ? { case: currentCase.name } : {}) };
    if (currentCase?.status === "running") currentCase.status = "failed";
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A failed invocation cannot leave a prior successful result behind.
    await rm(proofPath, { force: true });
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
    stage = "arguments";
    requireCondition(!args.length || (args.length === 2 && args[0] === "--port"));
    requireCondition(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && !process.env.DEBUG && !process.env.PWDEBUG);
    stage = "source-before"; proof.source.before = await source();
    proof.target.expectedSha = proof.source.before.sha;
    if (process.env.MILLE_QA_BASE_URL) {
      requireCondition(!args.length);
      proof.target.origin = previewOrigin(process.env.MILLE_QA_BASE_URL);
    } else {
      stage = "server"; proof.resources.servers = null; proof.resources.databases = null;
      server = await startCloudServer({ port: cloudPort(args[1] ?? process.env.PORT ?? 3000), hostname: "127.0.0.1", quiet: false, handleSignals: false });
      proof.resources.servers = 1; proof.resources.databases = 1;
      proof.target.origin = new URL(server.url).origin;
    }
    requireCondition(!interrupted);
    const origin = proof.target.origin;
    const protection = proof.target.kind === "preview" ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET : undefined;
    stage = "launch";
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, env: isolatedEnvironment(process.env) });
    proof.resources.browsers = 1; proof.environment.chromium = browser.version();
    for (const mobile of [false, true]) {
      const loggedIn: { page: Page; context: BrowserContext; item: CheckCase; user: (typeof TEST_USERS)[number]; started: number; boundaryFailed(): boolean }[] = [];
      for (const user of TEST_USERS) {
        const item = proof.cases.find(entry => entry.mobile === mobile && entry.userKey === user.key)!;
        currentCase = item; item.status = "running";
        const caseStarted = Date.now();
        stage = "context"; requireCondition(!interrupted);
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", acceptDownloads: false,
        });
        contexts.add(context); proof.resources.browserContexts = contexts.size;
        const page = await context.newPage(); page.setDefaultTimeout(30_000);
        await page.addInitScript(() => {
          window.addEventListener("pageshow", event => {
            if (!event.persisted) return;
            sessionStorage.setItem("mille:qa-history-restored", "1");
            const content = document.querySelector('[data-testid="authenticated-home"]');
            if (content && content.getClientRects().length && getComputedStyle(content).visibility !== "hidden") {
              // Only a boolean observation is retained, never protected page content.
              sessionStorage.setItem("mille:qa-history-visible", "1");
            }
          });
        });
        let requestBoundaryFailed = false;
        // CDP observes every redirect hop; context-wide headers would leak to other origins.
        const interception = await context.newCDPSession(page);
        interception.on("Fetch.requestPaused", async event => {
          try {
            if (new URL(event.request.url).origin !== origin) {
              requestBoundaryFailed = true;
              await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            } else {
              const headers = Object.entries(event.request.headers).filter(([name]) => name.toLowerCase() !== "x-vercel-protection-bypass");
              headers.push(...Object.entries(scopedProtectionHeaders(event.request.url, origin, protection)));
              await interception.send("Fetch.continueRequest", { requestId: event.requestId, headers: headers.map(([name, value]) => ({ name, value: String(value) })) });
            }
          } catch {
            requestBoundaryFailed = true;
            try { await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }); } catch { /* Context may already be closed. */ }
          }
        });
        await interception.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        stage = "navigation";
        const response = await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
        requireCondition(response?.status() === 200 && new URL(page.url()).origin === origin);
        stage = "runtime";
        const runtime = await page.evaluate(async () => {
          const response = await fetch("/api/runtime", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
          return { status: response.status, body: await response.json() };
        });
        requireCondition(runtime.status === 200 && runtime.body.app === "mille" && runtime.body.sha === proof.target.expectedSha);
        proof.target.runtimeSha = runtime.body.sha; item.checks.push("runtime-sha");
        const anonymous = await readIdentity(page);
        requireCondition(anonymous.status === 401); item.checks.push("anonymous-api-denied");
        stage = "login";
        await page.getByRole("button", { name: `${user.name}でログイン`, exact: true }).click();
        await page.getByTestId("authenticated-home").waitFor();
        requireCondition((await page.getByTestId("authenticated-user-email").textContent())?.trim() === user.email);
        item.checks.push("test-login");
        stage = "identity";
        const identity = await readIdentity(page), session = await readIdentity(page, "/api/auth/session");
        requireCondition(identity.status === 200 && identity.body.user?.id === user.id && identity.body.user?.email === user.email
          && identity.cacheControl?.includes("no-store") && session.status === 200 && session.body.user?.id === user.id);
        item.checks.push("own-identity");
        stage = "reload";
        await page.reload({ waitUntil: "networkidle" }); await page.getByTestId("authenticated-home").waitFor();
        requireCondition((await readIdentity(page)).body.user?.id === user.id);
        item.checks.push("session-after-reload");
        const filename = `${item.name}-home.png`;
        await page.screenshot({ path: resolve(directory, filename), fullPage: true }); item.screenshots.push(filename);
        requireCondition(!requestBoundaryFailed && !interrupted);
        loggedIn.push({ page, context, item, user, started: caseStarted, boundaryFailed: () => requestBoundaryFailed });
      }
      stage = "isolation";
      for (const entry of loggedIn) {
        currentCase = entry.item;
        const identity = await readIdentity(entry.page);
        requireCondition(identity.status === 200 && identity.body.user?.id === entry.user.id && identity.body.user?.email === entry.user.email);
        entry.item.checks.push("separate-context-identity");
      }
      for (const entry of loggedIn) {
        currentCase = entry.item; stage = "history-setup";
        await entry.page.evaluate(() => {
          sessionStorage.removeItem("mille:qa-history-visible");
          sessionStorage.removeItem("mille:qa-history-restored");
        });
        // Two authenticated documents leave a known protected entry behind logout's hard replacement.
        for (const step of [1, 2]) {
          await entry.page.goto(`${origin}/?qa-history=${encodeURIComponent(`${entry.item.name}-${step}`)}`, { waitUntil: "networkidle" });
          await entry.page.getByTestId("authenticated-home").waitFor();
          requireCondition((await readIdentity(entry.page)).body.user?.id === entry.user.id);
        }
        stage = "logout";
        await entry.page.getByRole("button", { name: "ログアウト", exact: true }).click();
        await entry.page.getByRole("button", { name: `${entry.user.name}でログイン`, exact: true }).waitFor();
        requireCondition((await readIdentity(entry.page)).status === 401);
        await entry.page.reload({ waitUntil: "networkidle" });
        requireCondition((await readIdentity(entry.page)).status === 401);
        entry.item.checks.push("logout-api-denied", "logout-after-reload");
        stage = "logout-history";
        const historyResponse = await entry.page.goBack({ waitUntil: "networkidle", timeout: 60_000 });
        if (historyResponse) {
          requireCondition(new URL(historyResponse.url()).searchParams.get("qa-history") === `${entry.item.name}-1`);
        }
        requireCondition(!await entry.page.getByTestId("authenticated-home").isVisible());
        requireCondition((await readIdentity(entry.page)).status === 401);
        const history = await entry.page.evaluate(() => ({
          visibleAtRestore: sessionStorage.getItem("mille:qa-history-visible") === "1",
          restoredFromCache: sessionStorage.getItem("mille:qa-history-restored") === "1",
        }));
        requireCondition(!history.visibleAtRestore);
        entry.item.history = { restoredFromCache: history.restoredFromCache };
        entry.item.checks.push("logout-history-denied");
        const other = loggedIn.find(value => value !== entry && value.item.status === "running");
        if (other) requireCondition((await readIdentity(other.page)).body.user?.id === other.user.id);
        requireCondition(!entry.boundaryFailed() && !interrupted);
        entry.item.status = "passed"; entry.item.durationMs = Date.now() - entry.started;
        await entry.context.close(); contexts.delete(entry.context); proof.resources.browserContexts = contexts.size;
      }
    }
    currentCase = undefined;
    requireCondition(!interrupted && proof.cases.length === 4 && proof.cases.every(item => item.status === "passed"));
  } catch (error) {
    if (error instanceof CloudStartupError && error.cleanupSucceeded) { proof.resources.servers = 0; proof.resources.databases = 0; }
    fail(interrupted ? "interrupted" : stage);
  } finally {
    stage = "cleanup";
    for (const context of contexts) {
      try { await context.close(); contexts.delete(context); } catch { fail(stage); }
    }
    proof.resources.browserContexts = contexts.size;
    if (browser) {
      try { await browser.close(); proof.resources.browsers = 0; contexts.clear(); proof.resources.browserContexts = 0; }
      catch { fail(stage); }
    }
    if (server) {
      try { await server.close(); proof.resources.servers = 0; proof.resources.databases = 0; }
      catch { proof.resources.servers = null; proof.resources.databases = null; fail(stage); }
    }
    stage = "source-after";
    try {
      proof.source.after = await source(); proof.source.unchanged = sourceUnchanged(proof.source.before, proof.source.after);
      if (!proof.source.unchanged) fail(stage);
    } catch { fail(stage); }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    proof.finishedAt = new Date().toISOString(); proof.durationMs = Date.now() - started;
    proof.success = !proof.failure && proof.cases.every(item => item.status === "passed") && proof.cases.length === 4
      && proof.source.unchanged && Object.values(proof.resources).every(count => count === 0);
    await writeFile(`${proofPath}.tmp`, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
    await rename(`${proofPath}.tmp`, proofPath);
  }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyBrowser(process.argv.slice(2)).then(proof => {
    const passed = proof.cases.filter(item => item.status === "passed").length;
    console.log(`MILLE_BROWSER_${proof.success ? "PASSED" : "FAILED"} cases=${passed}/${proof.cases.length} resources=${JSON.stringify(proof.resources)}${proof.failure ? ` stage=${proof.failure.stage}` : ""}`);
    if (!proof.success) process.exitCode = process.exitCode || 1;
  }).catch(() => { console.error("Milleブラウザ検証の結果を保存できませんでした。"); process.exitCode = 1; });
}
