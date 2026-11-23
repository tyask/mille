import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { previewOrigin, scopedProtectionHeaders, verifyBrowser, type BrowserProof } from "../cloud/verify";
import { isTrustedMainWorkflowPath } from "./github";
import { milleRepositoryId } from "./native-identity";
import { identifyStandingDatabase, prepareStandingDatabase, standingDatabaseResourceSchema } from "./standing-database";
import { StandingAliasError, standingLegacyPreview, standingPreviewAlias, StandingPreviewVercel, standingProductionAliases, StandingProductionPending,
  type StandingPreviewAlias } from "./standing-vercel";
import { readPreviewTree } from "./source";
import { readDevelopmentOidc, readVerifiedBrowserEvidence } from "./verify";

const repository = "tyask/mille";
const fixedOrigin = `https://${standingPreviewAlias}`;
const shaPattern = z.string().regex(/^[a-f0-9]{40}$/);
const runtimePayload = z.object({ app: z.literal("mille"), sha: shaPattern });
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const runNumber = z.string().regex(/^[1-9][0-9]*$/);
const caseNames = ["desktop-user-a", "desktop-user-b", "mobile-user-a", "mobile-user-b"] as const;

export const standingPreviewReceiptSchema = z.strictObject({
  protocol: z.literal("mille-standing-preview/v1"), runId: runNumber, runAttempt: runNumber, controlSha: shaPattern,
  ci: z.strictObject({ runId: z.int().positive(), attempt: z.int().positive(), jobId: z.int().positive() }),
  production: z.strictObject({ deploymentId, aliases: z.record(z.enum(standingProductionAliases), deploymentId) }),
  legacy: z.strictObject({ deploymentId: z.literal(standingLegacyPreview.deploymentId),
    origin: z.literal(standingLegacyPreview.origin), sha: z.literal(standingLegacyPreview.sha) }),
  release: z.strictObject({ id: deploymentId, origin: z.string().regex(/^https:\/\/[a-z0-9-]+\.vercel\.app$/), sha: shaPattern }),
  database: standingDatabaseResourceSchema,
  alias: z.strictObject({ origin: z.literal(fixedOrigin), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) }),
  browser: z.strictObject({ runtimeSha: shaPattern, finishedAt: z.iso.datetime(), durationMs: z.number().nonnegative(),
    cases: z.array(z.strictObject({ name: z.enum(caseNames), status: z.literal("passed") })).length(caseNames.length) }),
}).refine(receipt => receipt.release.sha === receipt.controlSha && receipt.browser.runtimeSha === receipt.controlSha
  && new Set(receipt.browser.cases.map(item => item.name)).size === caseNames.length
  && Object.values(receipt.production.aliases).every(id => id === receipt.production.deploymentId));

type CheckCurrent = () => Promise<void>;
type Database = Awaited<ReturnType<typeof identifyStandingDatabase>>;
type Release = Awaited<ReturnType<StandingPreviewVercel["readDeployment"]>>;
type Stage = "prerequisites" | "preflight" | "migration" | "deploy" | "browser" | "publish" | "restore-alias" | "restored-alias";
type Operations = {
  verifyCurrent: CheckCurrent;
  verifyPriorMain: (priorSha: string) => Promise<void>;
  vercel: Pick<StandingPreviewVercel, "preflight" | "readBaseline" | "readAlias" | "deploy" | "readDeployment" | "assignAlias" | "removeAlias" | "restoreAlias">;
  identifyDatabase: () => Promise<Database>;
  prepareDatabase: (database: Database, verifyCurrent: CheckCurrent, initial: boolean) => ReturnType<typeof prepareStandingDatabase>;
  readSource: () => ReturnType<typeof readPreviewTree>;
  browse: (release: Release) => Promise<BrowserProof>;
  checkRuntime: (origin: string, sha: string, previousSha?: string) => Promise<void>;
};

function protectionConfirmed(response: Response): boolean {
  if (response.status === 401) return true;
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  const location = response.headers.get("location");
  if (!location) return false;
  try {
    const destination = new URL(location);
    return destination.origin === "https://vercel.com" && !destination.username && !destination.password
      && ["/sso-api", "/login"].includes(destination.pathname);
  } catch { return false; }
}

class StandingRuntimeError extends Error {}

class StandingAliasPropagationPending extends StandingRuntimeError {
  constructor() { super("固定 URL の配信先の反映を確認できません。"); }
}

function deploymentNotFound(response: Response): boolean {
  return response.status === 404 && response.headers.get("x-vercel-error") === "DEPLOYMENT_NOT_FOUND";
}

export async function checkProtectedRuntime(origin: string, sha: string, token: string, request: typeof fetch = fetch,
  previousSha?: string) {
  if (previewOrigin(origin) !== origin) throw new Error("常設 Preview の origin が一致しません。");
  const url = new URL("/api/runtime", origin);
  const init = { method: "GET", redirect: "manual", cache: "no-store" } as const;
  const anonymous = await Promise.all([new URL("/", origin), url].map(target =>
    request(target, { ...init, signal: AbortSignal.timeout(15_000) })));
  if (!anonymous.every(protectionConfirmed)) {
    if (anonymous.every(response => protectionConfirmed(response) || deploymentNotFound(response))) {
      throw new StandingAliasPropagationPending();
    }
    throw new StandingRuntimeError("常設 Preview の未認証アクセスを遮断できません。");
  }
  const authenticated = await request(url, { ...init, redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: scopedProtectionHeaders(url.href, origin, token, "x-vercel-trusted-oidc-idp-token") });
  if (deploymentNotFound(authenticated)) throw new StandingAliasPropagationPending();
  const payload: unknown = authenticated.status === 200 ? await authenticated.json().catch(() => null) : null;
  const parsed = runtimePayload.safeParse(payload);
  const runtimeSha = parsed.data?.sha;
  if (runtimeSha === sha) return;
  if (previousSha !== undefined && runtimeSha === previousSha) throw new StandingAliasPropagationPending();
  throw new StandingRuntimeError("常設 Preview の実行時 SHA が一致しません。");
}

async function verifyPublishedRuntime(checkRuntime: () => Promise<void>, verifyBinding: CheckCurrent,
  wait: (duration: number) => Promise<void>) {
  for (const duration of [2_000, 4_000, 8_000]) {
    try { return await checkRuntime(); }
    catch (error) { if (!(error instanceof StandingAliasPropagationPending)) throw error; }
    await verifyBinding();
    await wait(duration);
  }
  await checkRuntime();
}

export async function publishStandingPreview(sha: string, operations: Operations,
  report: (stage: Stage, binding?: StandingPreviewAlias) => void = () => {},
  { allowFirstAssignment = false, wait = delay }: { allowFirstAssignment?: boolean; wait?: (duration: number) => Promise<void> } = {}) {
  const { verifyCurrent, verifyPriorMain, vercel, identifyDatabase, prepareDatabase, readSource, browse, checkRuntime } = operations;
  report("preflight");
  await verifyCurrent();
  const [initialBaseline, database, originalAlias] = await Promise.all([
    vercel.readBaseline(), identifyDatabase(), vercel.readAlias(), vercel.preflight(),
  ]);
  if (initialBaseline.productionSha !== sha) throw new Error("現用本番の SHA と main が一致しません。");
  if (!originalAlias && !allowFirstAssignment) throw new Error("既存の固定 URL の割り当てを確認できません。");
  const checkBaseline = async () => {
    await verifyCurrent();
    const [currentBaseline, currentDatabase] = await Promise.all([vercel.readBaseline(), identifyDatabase()]);
    if (!isDeepStrictEqual(initialBaseline, currentBaseline) || !isDeepStrictEqual(database, currentDatabase)) {
      throw new Error("本番・旧常設・常設 DB の照合先が変わりました。");
    }
  };
  const checkBeforePublish = async () => {
    await checkBaseline();
    if (!isDeepStrictEqual(originalAlias, await vercel.readAlias())) throw new Error("固定 URL の割り当てが変わりました。");
    await verifyCurrent();
  };
  await checkRuntime(standingLegacyPreview.origin, standingLegacyPreview.sha);

  const previous = originalAlias ? await vercel.readDeployment(originalAlias.deploymentId, undefined, database.endpointId) : null;
  if (previous && previous.sha !== sha) {
    await verifyPriorMain(previous.sha);
    await checkRuntime(previous.origin, previous.sha);
    await checkRuntime(fixedOrigin, previous.sha);
  }
  let release: Release;
  if (previous?.sha === sha) {
    release = previous;
  } else {
    const files = await readSource();
    report("migration");
    await checkBeforePublish();
    const configuration = await prepareDatabase(database, checkBeforePublish, !originalAlias);
    report("deploy");
    release = await vercel.deploy({ sha, database: configuration, endpointId: database.endpointId, files }, checkBeforePublish);
  }

  if (release.sha !== sha || release.origin === fixedOrigin || release.origin === standingLegacyPreview.origin
    || Object.hasOwn(initialBaseline.productionAliases, new URL(release.origin).hostname)) {
    throw new Error("常設 Preview の固有 URL が一致しません。");
  }
  report("browser");
  await checkBeforePublish();
  const browser = readVerifiedBrowserEvidence(sha, release, await browse(release));
  const checkRelease = async (expected: Release) => {
    if (!isDeepStrictEqual(expected, await vercel.readDeployment(expected.id, expected.sha, database.endpointId))) {
      throw new Error("常設 Preview のデプロイが変わりました。");
    }
  };
  await checkRelease(release);
  await checkRuntime(standingLegacyPreview.origin, standingLegacyPreview.sha);
  await checkBeforePublish();

  report("publish");
  let alias = originalAlias;
  let assignedAlias: StandingPreviewAlias | undefined;
  try {
    if (alias?.deploymentId !== release.id) {
      alias = await vercel.assignAlias(release.id, async () => {
        await checkRelease(release);
        if (previous) await checkRelease(previous);
        await checkBeforePublish();
      }, assigned => { assignedAlias = assigned; }, originalAlias);
    }
    const verifyBinding = async () => {
      await checkBaseline();
      await checkRelease(release);
      if (alias?.deploymentId !== release.id || !isDeepStrictEqual(alias, await vercel.readAlias())) {
        throw new Error("固定 URL の割り当てが一致しません。");
      }
      await verifyCurrent();
    };
    await verifyPublishedRuntime(() => checkRuntime(fixedOrigin, sha, previous?.sha), verifyBinding, wait);
    await verifyBinding();
  } catch (error) {
    if (assignedAlias?.deploymentId === release.id) {
      report("restore-alias", assignedAlias);
      if (originalAlias && previous) {
        const restored = await vercel.restoreAlias(assignedAlias, originalAlias, async () => {
          await checkRelease(previous);
          await checkRelease(release);
          await checkRuntime(previous.origin, previous.sha);
        });
        const verifyRestored = async () => {
          if (!isDeepStrictEqual(restored, await vercel.readAlias())) throw new Error("固定 URL の割り当てを復元できません。");
        };
        await verifyPublishedRuntime(() => checkRuntime(fixedOrigin, previous.sha, release.sha), verifyRestored, wait);
        await verifyRestored();
        report("restored-alias", restored);
      } else {
        await vercel.removeAlias(assignedAlias, () => checkRelease(release));
        if (await vercel.readAlias()) throw new Error("固定 URL の割り当てを復元できません。");
        report("restored-alias", assignedAlias);
      }
    }
    throw error;
  }
  return {
    controlSha: sha,
    production: { deploymentId: initialBaseline.productionDeploymentId, aliases: initialBaseline.productionAliases },
    legacy: { ...standingLegacyPreview, deploymentId: initialBaseline.legacyDeploymentId },
    release,
    database: { projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId },
    alias: { origin: fixedOrigin, id: alias.uid },
    browser,
  };
}

const envSchema = z.object({
  GITHUB_REPOSITORY: z.literal(repository), GITHUB_REF: z.literal("refs/heads/main"),
  GITHUB_WORKFLOW_REF: z.literal(`${repository}/.github/workflows/standing-preview.yml@refs/heads/main`),
  GITHUB_EVENT_NAME: z.enum(["push", "workflow_dispatch"]), GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_SHA: shaPattern, GITHUB_RUN_ID: runNumber, GITHUB_RUN_ATTEMPT: runNumber,
  GH_TOKEN: z.string().min(1), NEON_API_KEY: z.string().min(1), VERCEL_TOKEN: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
});
const eventSchema = z.object({ repository: z.object({ id: z.literal(milleRepositoryId), full_name: z.literal(repository) }) });
const pushSchema = eventSchema.extend({ ref: z.literal("refs/heads/main"), after: shaPattern, deleted: z.literal(false) });
const dispatchSchema = eventSchema.extend({ inputs: z.object({ sha: shaPattern }) });
const mainRef = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha: shaPattern }) });
const mainAncestry = z.object({ status: z.literal("ahead"), base_commit: z.object({ sha: shaPattern }),
  merge_base_commit: z.object({ sha: shaPattern }), behind_by: z.literal(0), ahead_by: z.int().positive() });
const runList = z.object({ workflow_runs: z.array(z.object({
  id: z.int().positive(), run_attempt: z.int().positive(), head_branch: z.literal("main"), head_sha: shaPattern,
  event: z.literal("push"), status: z.string(), conclusion: z.string().nullable(), path: z.string(),
  repository: z.object({ id: z.literal(milleRepositoryId) }), head_repository: z.object({ id: z.literal(milleRepositoryId) }),
})) });
const checkResult = { name: z.string(), status: z.string(), conclusion: z.string().nullable() };
const jobList = z.object({ total_count: z.int().nonnegative(), jobs: z.array(z.object({
  ...checkResult, id: z.int().positive(), run_id: z.int().positive(), run_attempt: z.int().positive().optional(), head_sha: shaPattern,
  steps: z.array(z.object(checkResult)).nullable().optional(),
})) });

export class StandingMainCiPending extends Error {
  constructor() { super("最新 main の CI の完了を待っています。"); }
}

export async function readStandingMainCi(read: (path: string) => Promise<unknown>, sha: string) {
  sha = shaPattern.parse(sha);
  const [run] = runList.parse(await read(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=10`)).workflow_runs;
  if (!run) throw new StandingMainCiPending();
  if (run.head_sha !== sha || !isTrustedMainWorkflowPath(run.path, "ci.yml", sha)) {
    throw new Error("現 main の CI の SHA とワークフローが一致しません。");
  }
  if (run.status !== "completed") throw new StandingMainCiPending();
  if (run.conclusion !== "success") throw new Error("現 main の CI が成功していません。");
  const { jobs, total_count } = jobList.parse(await read(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`));
  const checks = jobs.filter(job => job.name === "check");
  const [check] = checks;
  const checkoutProof = check?.steps?.filter(step => step.name === "照合したソースとテスト対象を記録");
  if (jobs.length !== total_count || checks.length !== 1 || check.run_id !== run.id || check.head_sha !== sha
    || (check.run_attempt !== undefined && check.run_attempt !== run.run_attempt)
    || check.status !== "completed" || check.conclusion !== "success" || checkoutProof?.length !== 1
    || checkoutProof[0].status !== "completed" || checkoutProof[0].conclusion !== "success") {
    throw new Error("現 main の CI check と checkout が一致しません。");
  }
  return { runId: run.id, attempt: run.run_attempt, jobId: check.id };
}

async function waitForPrerequisites(read: (path: string) => Promise<unknown>, vercel: StandingPreviewVercel,
  sha: string, verifyCurrent: CheckCurrent) {
  const deadline = Date.now() + 22 * 60_000;
  while (Date.now() < deadline) {
    await verifyCurrent();
    try {
      const ci = await readStandingMainCi(read, sha);
      await vercel.readBaseline(sha);
      return ci;
    } catch (error) {
      if (!(error instanceof StandingMainCiPending || error instanceof StandingProductionPending)) throw error;
    }
    await delay(15_000);
  }
  throw new Error("最新 main の CI と本番デプロイの反映を確認できませんでした。");
}

async function main() {
  const env = envSchema.parse(process.env);
  const event: unknown = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const manual = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const sha = env.GITHUB_SHA;
  const requestedSha = manual ? dispatchSchema.parse(event).inputs.sha : pushSchema.parse(event).after;
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (requestedSha !== sha || git(["rev-parse", "HEAD"]) !== sha
    || git(["status", "--porcelain=v1"])) throw new Error("信頼済み main の checkout が一致しません。");
  const read = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error("GitHub の main または CI を取得できません。");
    return response.json() as Promise<unknown>;
  };
  const verifyCurrent = async () => {
    if (mainRef.parse(await read("git/ref/heads/main")).object.sha !== sha) throw new Error("確認中に main が変わりました。");
  };
  const verifyPriorMain = async (previous: string) => {
    const prior = shaPattern.parse(previous);
    const ancestry = mainAncestry.parse(await read(`compare/${prior}...${sha}?per_page=1`));
    if (ancestry.base_commit.sha !== prior || ancestry.merge_base_commit.sha !== prior) {
      throw new Error("従来の固定 URL の SHA を main の履歴で照合できません。");
    }
  };
  const vercel = new StandingPreviewVercel({
    token: env.VERCEL_TOKEN, teamId: env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID, projectId: env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID,
  });
  await mkdir(".mille/cloud", { recursive: true, mode: 0o700 });
  let phase: Stage = "prerequisites";
  try {
    const ci = await waitForPrerequisites(read, vercel, sha, verifyCurrent);
    const result = await publishStandingPreview(sha, {
      verifyCurrent, verifyPriorMain,
      vercel,
      identifyDatabase: () => identifyStandingDatabase(env.NEON_API_KEY),
      prepareDatabase: (identity, verify, initial) => prepareStandingDatabase(env.NEON_API_KEY, identity,
        { verifyCurrent: verify, allowInitialMigrations: initial }),
      readSource: () => readPreviewTree(process.cwd(), sha),
      browse: async target => verifyBrowser([], { origin: target.origin, sha: target.sha, token: await readDevelopmentOidc(env) }),
      checkRuntime: async (origin, sha, previousSha) => checkProtectedRuntime(origin, sha, await readDevelopmentOidc(env), fetch, previousSha),
    }, (stage, binding) => {
      phase = stage;
      console.log(`常設 Preview の工程 ${stage}${binding ? ` ${JSON.stringify(binding)}` : ""}`);
    }, { allowFirstAssignment: manual });
    const receipt = JSON.stringify(standingPreviewReceiptSchema.parse({ protocol: "mille-standing-preview/v1", runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT, ci, ...result }));
    await writeFile(".mille/cloud/standing-preview-proof.json", `${receipt}\n`, { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `常設 Preview 更新\n\n\`\`\`json\n${receipt}\n\`\`\`\n`);
    }
  } catch (error) {
    if (error instanceof StandingAliasError) console.error(`固定 URL の照合結果 ${JSON.stringify(error.receipt)}`);
    if (error instanceof StandingRuntimeError) console.error(error.message);
    console.error(`常設 Preview の処理を停止しました（${phase}）。`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("信頼済み main と CI を照合できませんでした。");
    process.exitCode = 1;
  });
}
