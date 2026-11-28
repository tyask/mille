import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import { TEST_USERS } from "../../lib/shared/test-users";
import type { IssuedInvitation, Workspace, WorkspaceState } from "../../lib/shared/workspaces";
import { CloudStartupError, cloudPort, isolatedEnvironment, rootDirectory, startCloudServer, type CloudServer } from "./dev";
import { openSidebar, sidebarToggle, switchWorkspace, verifyMealReads, verifyMealSuggestions, verifySharedMeals } from "./meal-verify";
import { verifyMealPhotoFlow } from "./meal-photo-verify";
import { verifyMobileAccessQr } from "./mobile-access-qr-verify";

// Playwright resolves its executable registry on import, before launch({ env }) applies.
// Keep this process's lookup aligned with setup:cloud and preserve an explicit override.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(rootDirectory, "../.cache/ms-playwright");

const executeFile = promisify(execFile);
type Source = { sha: string; branch: string; clean: boolean };
type FormalPreview = { origin: string; sha: string; token: string };
type InterceptionFailure = {
  operation: "parse-request" | "foreign-origin" | "blocked-method" | "blocked-target" | "continue-request" | "continue-response";
  reason: "foreign-origin" | "blocked-method" | "blocked-target" | "invalid-interception-id" | "target-closed" | "other";
};
type CheckCase = {
  name: string; userKey: string; mobile: boolean; status: "not-run" | "running" | "passed" | "failed";
  checks: string[]; screenshots: string[]; durationMs: number;
  history?: { restoredFromCache: boolean };
  interceptionFailures?: InterceptionFailure[];
  canceledInterceptions?: number;
};

const formalDocumentPolicy = "worker-src 'none'; frame-src 'none'; object-src 'none'; connect-src 'self'; form-action 'self'";
export type BrowserProof = {
  protocol: "mille-browser/v1"; success: boolean; startedAt: string; finishedAt: string; durationMs: number;
  source: { before: Source | null; after: Source | null; unchanged: boolean };
  target: { kind: "local" | "preview"; origin: string | null; expectedSha: string | null; runtimeSha: string | null };
  environment: { platform: string; node: string; chromium: string | null };
  cases: CheckCase[]; failure?: { stage: string; case?: string };
  resources: { browserContexts: number; browsers: number; servers: number | null; databases: number | null; workspaces: number };
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
export function scopedProtectionHeaders(requestUrl: string, origin: string, secret?: string,
  header: "x-vercel-protection-bypass" | "x-vercel-trusted-oidc-idp-token" = "x-vercel-protection-bypass"): Record<string, string> {
  return secret && new URL(requestUrl).origin === origin ? { [header]: secret } : {};
}

export function allowsFormalPreviewRequest(method: string, pathname: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method)
    || (method === "POST" && ["/api/auth/callback/test-login", "/api/auth/signout"].includes(pathname));
}

export function isVercelToolbarRequest(method: string, resourceType: string, url: string): boolean {
  return method === "GET" && resourceType.toLowerCase() === "script"
    && url === "https://vercel.live/_next-live/feedback/feedback.js";
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

async function verifyRuntime(page: Page, expectedSha: string) {
  const runtime = await page.evaluate(async () => {
    const response = await fetch("/api/runtime", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() };
  });
  requireCondition(runtime.status === 200 && runtime.body.app === "mille" && runtime.body.sha === expectedSha);
}

async function workspaceRequest<T>(page: Page, path: string, method = "GET", body?: unknown) {
  const response = await page.evaluate(async ({ target, verb, payload }) => {
    const result = await fetch(target, {
      method: verb, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
      ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
    return { status: result.status, body: result.status === 204 ? null : await result.json(), cacheControl: result.headers.get("cache-control") };
  }, { target: path, verb: method, payload: body });
  return response as { status: number; body: T; cacheControl: string | null };
}

async function workspaceMutation<T>(page: Page, path: string, method: string, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method),
    action(),
  ]);
  requireCondition(response.status() >= 200 && response.status() < 300);
  return (response.status() === 204 ? null : await response.json()) as T;
}

async function selectedWorkspace(page: Page, name: string) {
  await page.getByTestId("workspace-selected-name").waitFor();
  await page.waitForFunction(expected => document.querySelector('[data-testid="workspace-selected-name"]')?.textContent?.trim() === expected, name);
}

async function clickSidebarMenu(page: Page, name: "献立" | "提案" | "ワークスペース設定") {
  await openSidebar(page);
  await page.locator("#ws-sidebar").getByRole("button", { name, exact: true }).click();
}

async function openWorkspaceSettings(page: Page) {
  await clickSidebarMenu(page, "ワークスペース設定");
  await page.getByTestId("workspace-member-list").waitFor();
}

async function openMeals(page: Page) {
  await clickSidebarMenu(page, "献立");
  await page.getByTestId("meal-app").waitFor();
}

async function confirmNavigation(page: Page, accept: boolean, action: () => Promise<unknown>) {
  await Promise.all([
    page.waitForEvent("dialog").then(async dialog => {
      const matches = dialog.type() === "confirm" && dialog.message().includes("保存していない入力");
      if (matches && accept) await dialog.accept();
      else await dialog.dismiss();
      requireCondition(matches);
    }),
    action(),
  ]);
}

async function verifyHomeNavigation(page: Page, currentId: string, otherId: string) {
  await openMeals(page);
  await clickSidebarMenu(page, "提案");
  const suggestions = page.getByTestId("suggestion-panel");
  await suggestions.waitFor();
  requireCondition(new URL(page.url()).searchParams.get("section") === "suggestion");
  await openWorkspaceSettings(page);
  requireCondition(new URL(page.url()).searchParams.get("section") === "settings");
  await page.goBack();
  await suggestions.waitFor();
  requireCondition(new URL(page.url()).searchParams.get("section") === "suggestion");
  await page.goForward();
  await page.getByTestId("workspace-member-list").waitFor();
  requireCondition(new URL(page.url()).searchParams.get("section") === "settings");

  await openMeals(page);
  await page.getByTestId("meal-register").click();
  const dishName = page.getByTestId("meal-editor-dish-name");
  const draft = "切り替えを取り消して保持する料理名";
  await dishName.fill(draft);
  await openSidebar(page);
  const select = page.getByTestId("workspace-select");
  await confirmNavigation(page, false, () => select.selectOption(otherId));
  requireCondition(await dishName.inputValue() === draft && await select.inputValue() === currentId
    && new URL(page.url()).searchParams.get("workspace") === currentId);
  await confirmNavigation(page, false, () => clickSidebarMenu(page, "ワークスペース設定"));
  requireCondition(await dishName.inputValue() === draft && new URL(page.url()).searchParams.get("section") === null);
  await confirmNavigation(page, true, () => clickSidebarMenu(page, "ワークスペース設定"));
  await page.getByTestId("workspace-member-list").waitFor();
  await page.getByTestId("meal-editor").waitFor({ state: "hidden" });
}

export async function verifyBrowser(args: readonly string[] = [], formal?: FormalPreview): Promise<BrowserProof> {
  const directory = resolve(rootDirectory, ".mille/cloud"), proofPath = resolve(directory, "verification.json");
  const started = Date.now();
  const proof: BrowserProof = {
    protocol: "mille-browser/v1", success: false, startedAt: new Date(started).toISOString(), finishedAt: "", durationMs: 0,
    source: { before: null, after: null, unchanged: false },
    target: { kind: formal || process.env.MILLE_QA_BASE_URL ? "preview" : "local", origin: null, expectedSha: null, runtimeSha: null },
    environment: { platform: process.platform, node: process.version, chromium: null },
    cases: [false, true].flatMap(mobile => TEST_USERS.map(user => ({
      name: `${mobile ? "mobile" : "desktop"}-${user.key}`, userKey: user.key, mobile,
      status: "not-run" as const, checks: [], screenshots: [], durationMs: 0,
    }))),
    resources: { browserContexts: 0, browsers: 0, servers: 0, databases: 0, workspaces: 0 },
  };
  let stage = "proof", currentCase: CheckCase | undefined;
  let server: CloudServer | undefined, browser: Browser | undefined;
  let interrupted = false;
  const contexts = new Set<BrowserContext>();
  const disposableWorkspaces = new Map<string, Page>();
  const mobileLoginUrls = new Map<string, string>();
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
    const expectedSha = formal?.sha ?? proof.source.before.sha;
    requireCondition(/^[a-f0-9]{40}$/.test(expectedSha));
    proof.target.expectedSha = expectedSha;
    if (formal) {
      requireCondition(!args.length && proof.source.before.clean && formal.token.length > 0);
      proof.target.origin = previewOrigin(formal.origin);
    } else if (process.env.MILLE_QA_BASE_URL) {
      requireCondition(!args.length);
      proof.target.origin = previewOrigin(process.env.MILLE_QA_BASE_URL);
    } else {
      stage = "server"; proof.resources.servers = null; proof.resources.databases = null;
      // Invitation URLs contain bearer capabilities; Next's request logs must not retain them.
      server = await startCloudServer({
        port: cloudPort(args[1] ?? process.env.PORT ?? 3000),
        hostname: "127.0.0.1",
        quiet: true,
        handleSignals: false,
        // The Next dev indicator can intercept clicks on the workspace's lower-left controls.
        browserQa: true,
      });
      proof.resources.servers = 1; proof.resources.databases = 1;
      proof.target.origin = new URL(server.url).origin;
    }
    requireCondition(!interrupted);
    const origin = proof.target.origin;
    const protection = proof.target.kind === "preview" ? formal?.token ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET : undefined;
    const protectionHeader = formal ? "x-vercel-trusted-oidc-idp-token" : "x-vercel-protection-bypass";
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
        const recordBoundaryFailure = (failure: InterceptionFailure) => {
          requestBoundaryFailed = true;
          if ((item.interceptionFailures?.length ?? 0) < 20) (item.interceptionFailures ??= []).push(failure);
        };
        const recordToolbarBlocked = () => {
          if (!item.checks.includes("vercel-toolbar-blocked")) item.checks.push("vercel-toolbar-blocked");
        };
        if (formal) {
          // Context routing sees the first popup request, before a page event can observe it.
          await context.route("**/*", async route => {
            const request = route.request();
            let allowed = false, toolbar = false;
            try {
              const url = new URL(request.url());
              const frame = request.frame();
              toolbar = frame === page.mainFrame() && isVercelToolbarRequest(request.method(), request.resourceType(), request.url());
              allowed = frame.page() === page && url.origin === origin && allowsFormalPreviewRequest(request.method(), url.pathname);
            } catch { /* A popup's initial navigation may not have an inspectable frame. */ }
            if (toolbar) {
              await route.abort("blockedbyclient");
              recordToolbarBlocked();
              return;
            }
            if (allowed) {
              await route.fallback();
              return;
            }
            recordBoundaryFailure({ operation: "blocked-target", reason: "blocked-target" });
            await route.abort("blockedbyclient");
          });
          await context.routeWebSocket("**/*", async route => {
            recordBoundaryFailure({ operation: "blocked-target", reason: "blocked-target" });
            await route.close({ code: 1008 });
          });
        }
        // CDP observes every redirect hop; context-wide headers would leak to other origins.
        const interception = await context.newCDPSession(page);
        const mainFrameId = formal ? (await interception.send("Page.getFrameTree")).frameTree.frame.id : undefined;
        interception.on("Fetch.requestPaused", async event => {
          let operation: InterceptionFailure["operation"] = "parse-request";
          try {
            const url = new URL(event.request.url);
            if (formal && event.frameId === mainFrameId && event.request.urlFragment === undefined
              && isVercelToolbarRequest(event.request.method, event.resourceType, event.request.url)) {
              await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
              recordToolbarBlocked();
            } else if (url.origin !== origin) {
              operation = "foreign-origin";
              recordBoundaryFailure({ operation, reason: "foreign-origin" });
              await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            } else if (formal && !allowsFormalPreviewRequest(event.request.method, url.pathname)) {
              operation = "blocked-method";
              recordBoundaryFailure({ operation, reason: "blocked-method" });
              await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            } else if (formal && (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined)) {
              operation = "continue-response";
              const headers = (event.responseHeaders ?? []).filter(({ name }) =>
                !["content-encoding", "content-length", "transfer-encoding", "location"].includes(name.toLowerCase()));
              headers.push({ name: "Content-Security-Policy", value: formalDocumentPolicy });
              if (event.responseStatusCode === 200) {
                // Workers can start on another CDP target. Apply a second policy before the document runs.
                const content = await interception.send("Fetch.getResponseBody", { requestId: event.requestId });
                await interception.send("Fetch.fulfillRequest", {
                  requestId: event.requestId, responseCode: 200, responseHeaders: headers,
                  body: content.base64Encoded ? content.body : Buffer.from(content.body, "utf8").toString("base64"),
                });
              } else {
                const code = event.responseStatusCode ?? 0;
                const locations = event.responseHeaders?.filter(({ name }) => name.toLowerCase() === "location") ?? [];
                const location = locations.length === 1 && locations[0].value.trim() ? new URL(locations[0].value, url) : null;
                if ([301, 302, 303, 307, 308].includes(code) && location?.origin === origin && !location.username && !location.password) {
                  headers.push({ name: "Location", value: location.href });
                  await interception.send("Fetch.fulfillRequest", {
                    requestId: event.requestId, responseCode: code, responseHeaders: headers, body: "",
                  });
                } else {
                  recordBoundaryFailure({ operation, reason: "blocked-target" });
                  await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
                }
              }
            } else {
              operation = "continue-request";
              const headers = Object.entries(event.request.headers).filter(([name]) =>
                !["x-vercel-protection-bypass", "x-vercel-trusted-oidc-idp-token"].includes(name.toLowerCase()));
              headers.push(...Object.entries(scopedProtectionHeaders(event.request.url, origin, protection, protectionHeader)));
              await interception.send("Fetch.continueRequest", { requestId: event.requestId, headers: headers.map(([name, value]) => ({ name, value: String(value) })) });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            const reason: InterceptionFailure["reason"] = /Invalid InterceptionId|Invalid interception id/i.test(message) ? "invalid-interception-id"
              : /Target closed|Session closed|Target page, context or browser has been closed/i.test(message) ? "target-closed" : "other";
            if ((operation === "continue-request" || operation === "continue-response") && reason === "invalid-interception-id") {
              // Navigation canceled this already verified same-origin request before CDP resumed it.
              // A stale interception ID cannot forward headers; foreign requests still fail above.
              item.canceledInterceptions = (item.canceledInterceptions ?? 0) + 1;
              return;
            }
            // Retain only bounded enums: protocol errors may otherwise include capability URLs.
            recordBoundaryFailure({ operation, reason });
            try { await interception.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }); } catch { /* Context may already be closed. */ }
          }
        });
        await interception.send("Fetch.enable", { patterns: [
          { urlPattern: "*", requestStage: "Request" },
          ...(formal ? [{ urlPattern: "*", resourceType: "Document" as const, requestStage: "Response" as const }] : []),
        ] });
        stage = "navigation";
        const scannedUrl = mobile ? mobileLoginUrls.get(user.key) : undefined;
        const response = await page.goto(scannedUrl ?? origin, { waitUntil: "networkidle", timeout: 60_000 });
        requireCondition(response?.status() === 200 && new URL(page.url()).origin === origin);
        stage = "runtime";
        await verifyRuntime(page, expectedSha);
        proof.target.runtimeSha = expectedSha; item.checks.push("runtime-sha");
        const anonymous = await readIdentity(page);
        requireCondition(anonymous.status === 401); item.checks.push("anonymous-api-denied");
        requireCondition((await workspaceRequest(page, "/api/workspaces")).status === 401);
        item.checks.push("anonymous-workspaces-denied");
        stage = "login";
        await page.getByRole("button", { name: `${user.name}でログイン`, exact: true }).click();
        await page.getByTestId("authenticated-home").waitFor();
        requireCondition((await page.getByTestId("authenticated-user-email").textContent())?.trim() === user.email);
        item.checks.push("test-login");
        if (scannedUrl) item.checks.push("mobile-login-from-scanned-qr");
        stage = "identity";
        const identity = await readIdentity(page), session = await readIdentity(page, "/api/auth/session");
        requireCondition(identity.status === 200 && identity.body.user?.id === user.id && identity.body.user?.email === user.email
          && identity.cacheControl?.includes("no-store") && session.status === 200 && session.body.user?.id === user.id);
        item.checks.push("own-identity");
        stage = "reload";
        await page.reload({ waitUntil: "networkidle" }); await page.getByTestId("authenticated-home").waitFor();
        requireCondition((await readIdentity(page)).body.user?.id === user.id);
        item.checks.push("session-after-reload");
        const sidebarLayout = proof.target.kind === "local" || Boolean(await page.getByTestId("workspace-select").count());
        if (sidebarLayout) {
          stage = "mobile-login-qr";
          const loginUrl = await verifyMobileAccessQr(page, origin, mobile);
          if (loginUrl) mobileLoginUrls.set(user.key, loginUrl);
          item.checks.push(mobile ? "mobile-access-qr-hidden" : "mobile-access-qr-decodes-to-home");
        }
        if (mobile) {
          stage = "mobile-menu-resize";
          const menu = sidebarToggle(page);
          await openSidebar(page);
          await page.waitForFunction(() => document.querySelector(".ws-main-shell")?.hasAttribute("inert") === true);
          if (proof.target.kind === "local") {
            const filename = `${item.name}-sidebar.png`;
            await page.screenshot({ path: resolve(directory, filename), animations: "disabled" });
            item.screenshots.push(filename);
          }
          await page.setViewportSize({ width: 844, height: 390 });
          if (sidebarLayout) {
            requireCondition(await menu.isVisible() && await menu.getAttribute("aria-expanded") === "true");
            await verifyMobileAccessQr(page, origin, true);
            await page.setViewportSize({ width: 1100, height: 650 });
            item.checks.push("landscape-mobile-menu-and-hidden-qr");
          }
          await page.waitForFunction(() => {
            const shell = document.querySelector(".ws-main-shell");
            return shell !== null && !shell.hasAttribute("inert");
          });
          await workspaceMutation(page, "/api/workspaces", "GET", () => page.getByTestId("workspace-refresh").click());
          if (proof.target.kind === "local") await openWorkspaceSettings(page);
          await page.getByTestId("workspace-create-open").click();
          await page.getByTestId("workspace-create-dialog").getByRole("button", { name: "キャンセル", exact: true }).click();
          await page.getByTestId("workspace-create-dialog").waitFor({ state: "hidden" });
          await page.setViewportSize({ width: 390, height: 844 });
          requireCondition(await menu.getAttribute("aria-expanded") === "false"
            && !await page.locator(".ws-main-shell").evaluate(element => element.hasAttribute("inert")));
          if (sidebarLayout) {
            await openSidebar(page);
            await page.getByTestId("workspace-create-open").waitFor();
            await page.keyboard.press("Escape");
            await menu.and(page.locator('[aria-expanded="false"]')).waitFor();
          } else {
            await page.getByTestId("workspace-create-open").waitFor();
          }
          if (proof.target.kind === "local") await openMeals(page);
          item.checks.push("mobile-menu-resize-restores-main");
        }
        if (proof.target.kind === "local") {
          const filename = `${item.name}-home.png`;
          await page.screenshot({ path: resolve(directory, filename), fullPage: true }); item.screenshots.push(filename);
        }
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

      const [owner, member] = loggedIn;
      currentCase = owner.item; stage = "workspace-personal-isolation";
      const [ownerState, memberState] = await Promise.all([
        workspaceRequest<WorkspaceState>(owner.page, "/api/workspaces"),
        workspaceRequest<WorkspaceState>(member.page, "/api/workspaces"),
      ]);
      requireCondition(ownerState.status === 200 && memberState.status === 200
        && ownerState.cacheControl?.includes("no-store") && memberState.cacheControl?.includes("no-store"));
      const ownerPersonal = ownerState.body.workspaces.find(workspace => workspace.type === "PERSONAL");
      const memberPersonal = memberState.body.workspaces.find(workspace => workspace.type === "PERSONAL");
      requireCondition(ownerPersonal && memberPersonal && ownerPersonal.id !== memberPersonal.id
        && ownerPersonal.members.length === 1 && ownerPersonal.members[0].userId === owner.user.id
        && memberPersonal.members.length === 1 && memberPersonal.members[0].userId === member.user.id
        && !ownerState.body.workspaces.some(workspace => workspace.id === memberPersonal.id)
        && !memberState.body.workspaces.some(workspace => workspace.id === ownerPersonal.id));
      for (const entry of loggedIn) entry.item.checks.push("personal-workspace-isolation");

      // The trusted main verifier may be checking an older PR whose UI predates meals.
      if (proof.target.kind === "local" || formal?.sha === proof.source.before.sha) {
        stage = "meal-read-isolation-and-calendar";
        currentCase = owner.item;
        await verifyMealReads({ page: owner.page, checks: owner.item.checks }, ownerPersonal.id, memberPersonal.id);
        currentCase = member.item;
        await verifyMealReads({ page: member.page, checks: member.item.checks }, memberPersonal.id, ownerPersonal.id);
      }

      if (proof.target.kind === "local") {
        currentCase = owner.item;
        stage = "workspace-create";
        await openWorkspaceSettings(owner.page);
        const workspaceName = `QA ${mobile ? "mobile" : "desktop"} ${Date.now()}`;
        await openSidebar(owner.page);
        await owner.page.locator("#ws-sidebar").getByTestId("workspace-create-open").click();
        await owner.page.getByTestId("workspace-create-dialog").getByLabel("ワークスペース名", { exact: true }).fill(workspaceName);
        await owner.page.getByTestId("workspace-create-dialog").getByRole("radio", { name: /共有用/ }).check();
        const created = await workspaceMutation<Workspace>(owner.page, "/api/workspaces", "POST", () => owner.page.getByTestId("workspace-create-submit").click());
        disposableWorkspaces.set(created.id, owner.page); proof.resources.workspaces = disposableWorkspaces.size;
        requireCondition(created.name === workspaceName && created.type === "SHARED");
        await selectedWorkspace(owner.page, workspaceName);
        owner.item.checks.push("shared-workspace-create-ui");

        stage = "workspace-switch-persistence";
        await openSidebar(owner.page);
        const select = owner.page.getByTestId("workspace-select");
        const labelledSelect = owner.page.locator("#ws-sidebar").getByRole("combobox", { name: "ワークスペース", exact: true });
        requireCondition(await select.count() === 1 && await select.and(labelledSelect).isVisible()
          && await select.evaluate(element => element instanceof HTMLSelectElement && !element.multiple && element.size <= 1)
          && await select.locator(`option[value="${ownerPersonal.id}"]`).textContent() === ownerPersonal.name
          && await select.locator(`option[value="${created.id}"]`).textContent() === workspaceName
          && await select.inputValue() === created.id && await owner.page.getByTestId("workspace-card").count() === 0);
        await switchWorkspace(owner.page, ownerPersonal.id);
        await selectedWorkspace(owner.page, ownerPersonal.name);
        await switchWorkspace(owner.page, created.id);
        await selectedWorkspace(owner.page, workspaceName);
        await owner.page.reload({ waitUntil: "networkidle" });
        await selectedWorkspace(owner.page, workspaceName);
        requireCondition(await select.inputValue() === created.id);
        await openWorkspaceSettings(owner.page);
        owner.item.checks.push("workspace-single-dropdown", "workspace-switch-ui", "workspace-selection-after-reload");

        stage = "home-navigation-and-unsaved-input";
        await verifyHomeNavigation(owner.page, created.id, ownerPersonal.id);
        owner.item.checks.push("sidebar-meal-suggestion-settings-navigation", "sidebar-navigation-history", "sidebar-navigation-draft-confirmation");

        stage = "workspace-rename-open";
        const renamed = `${workspaceName} 変更`;
        await owner.page.getByRole("button", { name: "名前を変更", exact: true }).click();
        stage = "workspace-rename-fill";
        await owner.page.getByTestId("workspace-rename-dialog").getByLabel("ワークスペース名", { exact: true }).fill(renamed);
        stage = "workspace-rename-save";
        await workspaceMutation<Workspace>(owner.page, `/api/workspaces/${created.id}`, "PATCH", () => owner.page.getByTestId("workspace-rename-dialog").getByRole("button", { name: "変更を保存", exact: true }).click());
        stage = "workspace-rename-result";
        await selectedWorkspace(owner.page, renamed);
        requireCondition(await select.locator(`option[value="${created.id}"]`).textContent() === renamed);
        owner.item.checks.push("workspace-rename-ui");

        stage = "workspace-duplicate-names";
        const reservedName = `${renamed}（共有用 1）`;
        const fixtures: Workspace[] = [];
        for (const fixture of [
          { name: renamed.replace("QA ", "QA  "), type: "PERSONAL" },
          { name: renamed, type: "SHARED" },
          { name: reservedName, type: "SHARED" },
        ]) {
          const { status, body } = await workspaceRequest<Workspace>(owner.page, "/api/workspaces", "POST", fixture);
          requireCondition(status === 201 && body.id);
          fixtures.push(body);
          disposableWorkspaces.set(body.id, owner.page); proof.resources.workspaces = disposableWorkspaces.size;
          requireCondition(body.name === fixture.name && body.type === fixture.type);
        }
        await owner.page.reload({ waitUntil: "networkidle" });
        const [samePersonal, sameShared, reserved] = fixtures;
        for (const [id, label] of [
          [samePersonal.id, `${renamed}（個人用）`],
          [sameShared.id, `${renamed}（共有用 3）`],
          [reserved.id, reservedName],
          [created.id, `${renamed}（共有用 2）`],
        ]) {
          await openSidebar(owner.page);
          const [selectedId] = await select.selectOption({ label });
          requireCondition(selectedId === id);
          await owner.page.locator(`[data-testid="workspace-selected-name"][data-workspace-id="${id}"]`).waitFor();
        }
        for (const fixture of fixtures) {
          const removed = await workspaceRequest(owner.page, `/api/workspaces/${fixture.id}`, "DELETE", { confirmationName: fixture.name });
          requireCondition(removed.status === 204);
          disposableWorkspaces.delete(fixture.id); proof.resources.workspaces = disposableWorkspaces.size;
        }
        await owner.page.reload({ waitUntil: "networkidle" });
        await selectedWorkspace(owner.page, renamed);
        requireCondition(await select.locator(`option[value="${created.id}"]`).textContent() === renamed);
        owner.item.checks.push("workspace-duplicate-names-distinguishable");

        stage = "workspace-invite";
        await owner.page.getByRole("button", { name: "メンバーを招待", exact: true }).click();
        await owner.page.getByTestId("workspace-invite-dialog").getByLabel("相手のメールアドレス", { exact: true }).fill(member.user.email);
        const invitation = await workspaceMutation<IssuedInvitation>(owner.page, `/api/workspaces/${created.id}/invitations`, "POST", () => owner.page.getByTestId("workspace-invite-dialog").getByRole("button", { name: "招待リンクを発行", exact: true }).click());
        requireCondition(/^[a-f0-9]{64}$/.test(invitation.token) && invitation.invitation.email === member.user.email);
        owner.item.checks.push("workspace-invite-ui");
        // The capability is used in memory only, and no screenshot is taken on these screens.
        currentCase = member.item;
        if (mobile) {
          stage = "workspace-incoming-invitation";
          await member.page.reload({ waitUntil: "networkidle" });
          await openWorkspaceSettings(member.page);
          const incoming = member.page.getByRole("region", { name: "届いている招待", exact: true }).getByRole("article").filter({ hasText: renamed });
          await incoming.getByRole("heading", { name: `「${renamed}」への招待`, exact: true }).waitFor();
          stage = "workspace-incoming-join";
          await workspaceMutation(member.page, `/api/invitations/${invitation.invitation.id}/join`, "POST", () => incoming.getByRole("button", { name: "参加する", exact: true }).click());
          await selectedWorkspace(member.page, renamed);
          member.item.checks.push("incoming-invitation-join-ui");
        } else {
          stage = "workspace-invitation-login";
          await member.page.getByRole("button", { name: "ログアウト", exact: true }).click();
          await member.page.getByRole("button", { name: `${member.user.name}でログイン`, exact: true }).waitFor();
          requireCondition((await readIdentity(member.page)).status === 401);
          await member.page.goto(`${origin}/invite/${invitation.token}`, { waitUntil: "networkidle" });
          await member.page.getByRole("button", { name: `${member.user.name}でログイン`, exact: true }).click();
          await member.page.getByTestId("workspace-join-submit").waitFor();
          requireCondition(new URL(member.page.url()).pathname === `/invite/${invitation.token}`
            && (await readIdentity(member.page)).body.user?.id === member.user.id);
          member.item.checks.push("invitation-login-return");
          stage = "workspace-join";
          await workspaceMutation(member.page, `/api/invitations/${invitation.token}/accept`, "POST", () => member.page.getByTestId("workspace-join-submit").click());
          await member.page.getByRole("link", { name: "ワークスペースを開く", exact: true }).click();
          await selectedWorkspace(member.page, renamed);
          member.item.checks.push("invitation-link-join-ui");
        }
        await owner.page.reload({ waitUntil: "networkidle" });
        await selectedWorkspace(owner.page, renamed);
        await openWorkspaceSettings(owner.page);
        const shared = await workspaceRequest<WorkspaceState>(owner.page, "/api/workspaces");
        const sharedWorkspace = shared.body.workspaces.find(workspace => workspace.id === created.id);
        requireCondition(shared.status === 200 && sharedWorkspace?.members.length === 2
          && sharedWorkspace.members.some(value => value.userId === owner.user.id)
          && sharedWorkspace.members.some(value => value.userId === member.user.id));
        requireCondition((await owner.page.getByTestId("workspace-member-count").textContent())?.trim() === "2");
        await owner.page.getByText(member.user.email, { exact: true }).waitFor();
        owner.item.checks.push("shared-members-after-join"); member.item.checks.push("shared-members-after-join");

        stage = "workspace-api-isolation";
        const forbidden = await workspaceRequest(member.page, `/api/workspaces/${ownerPersonal.id}`, "PATCH", { name: "不正な変更" });
        requireCondition(forbidden.status === 403 || forbidden.status === 404);
        const unchangedOwner = await workspaceRequest<WorkspaceState>(owner.page, "/api/workspaces");
        requireCondition(unchangedOwner.body.workspaces.find(workspace => workspace.id === ownerPersonal.id)?.name === ownerPersonal.name);
        member.item.checks.push("non-member-workspace-write-denied");

        stage = "meal-open-shared";
        await openMeals(owner.page);
        await openMeals(member.page);
        const mealCases = {
          owner: { page: owner.page, checks: owner.item.checks },
          member: { page: member.page, checks: member.item.checks },
          workspaceId: created.id,
          onStage: (mealStage: string, actor: "owner" | "member") => {
            stage = mealStage;
            currentCase = actor === "owner" ? owner.item : member.item;
          },
        };
        await verifySharedMeals({ ...mealCases, personalId: ownerPersonal.id });
        await verifyMealSuggestions(mealCases);
        await verifyMealPhotoFlow(mealCases.owner, mealCases.member, created.id, ownerPersonal.id, mealCases.onStage);
        stage = "meal-screenshot";
        const mealFilename = `${owner.item.name}-meals.png`;
        await owner.page.screenshot({ path: resolve(directory, mealFilename), fullPage: true });
        owner.item.screenshots.push(mealFilename);

        currentCase = member.item;
        stage = "workspace-member-rename";
        await openWorkspaceSettings(member.page);
        const memberRenamed = `${workspaceName} 共有`;
        await member.page.getByRole("button", { name: "名前を変更", exact: true }).click();
        await member.page.getByTestId("workspace-rename-dialog").getByLabel("ワークスペース名", { exact: true }).fill(memberRenamed);
        await workspaceMutation(member.page, `/api/workspaces/${created.id}`, "PATCH", () => member.page.getByTestId("workspace-rename-dialog").getByRole("button", { name: "変更を保存", exact: true }).click());
        await selectedWorkspace(member.page, memberRenamed);
        await owner.page.reload({ waitUntil: "networkidle" });
        await selectedWorkspace(owner.page, memberRenamed);
        member.item.checks.push("member-rename-ui"); owner.item.checks.push("member-update-visible");

        stage = "workspace-delete";
        await member.page.getByRole("button", { name: "削除する", exact: true }).click();
        await member.page.locator("#ws-delete-confirmation").fill(memberRenamed);
        await workspaceMutation(member.page, `/api/workspaces/${created.id}`, "DELETE", () => member.page.getByTestId("workspace-delete-submit").click());
        disposableWorkspaces.delete(created.id); proof.resources.workspaces = disposableWorkspaces.size;
        await owner.page.reload({ waitUntil: "networkidle" });
        for (const entry of loggedIn) {
          const state = await workspaceRequest<WorkspaceState>(entry.page, "/api/workspaces");
          requireCondition(state.status === 200 && !state.body.workspaces.some(workspace => workspace.id === created.id));
          const fallback = state.body.workspaces[0];
          requireCondition(fallback);
          await selectedWorkspace(entry.page, fallback.name);
          requireCondition(await entry.page.getByTestId("workspace-selected-name").getAttribute("data-workspace-id") === fallback.id
            && await entry.page.getByTestId("workspace-select").inputValue() === fallback.id);
          entry.item.checks.push("workspace-delete-ui-and-fallback");
          await openWorkspaceSettings(entry.page);
          const filename = `${entry.item.name}-workspaces.png`;
          await entry.page.screenshot({ path: resolve(directory, filename), fullPage: true }); entry.item.screenshots.push(filename);
        }
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
        await openSidebar(entry.page);
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
        stage = "logout-other-context-identity";
        if (other) requireCondition((await readIdentity(other.page)).body.user?.id === other.user.id);
        if (formal) {
          stage = "runtime-after";
          await verifyRuntime(entry.page, expectedSha);
          entry.item.checks.push("runtime-after");
        }
        stage = "logout-request-origin-boundary";
        requireCondition(!entry.boundaryFailed());
        stage = "logout-interruption";
        requireCondition(!interrupted);
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
    // A failed Preview run must also remove only the workspaces created by this run.
    for (const [workspaceId, page] of disposableWorkspaces) {
      try {
        const state = await workspaceRequest<WorkspaceState>(page, "/api/workspaces");
        requireCondition(state.status === 200);
        const workspace = state.body.workspaces.find(value => value.id === workspaceId);
        if (workspace) {
          const removed = await workspaceRequest(page, `/api/workspaces/${workspaceId}`, "DELETE", { confirmationName: workspace.name });
          requireCondition(removed.status === 204);
        }
        disposableWorkspaces.delete(workspaceId);
      } catch { fail(stage); }
    }
    proof.resources.workspaces = disposableWorkspaces.size;
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
