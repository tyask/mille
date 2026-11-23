import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { isTrustedMainWorkflowPath, previewGitHubRequest, type PreviewGitHubRequest } from "./github";
import { isNativePreviewTaskBranch, milleRepositoryId } from "./native-identity";
import { NativePilotVercel } from "./native-pilot-vercel";
import { NeonPreview } from "./neon";
import {
  checkProtectedRuntime, readStandingMainCi, StandingMainCiPending, standingPreviewReceiptSchema,
} from "./standing";
import { identifyStandingDatabase } from "./standing-database";
import { standingPreviewAlias, StandingPreviewVercel, StandingProductionPending } from "./standing-vercel";
import { VercelPreview } from "./vercel";
import { readDevelopmentOidc } from "./verify";

const repository = "tyask/mille";
const githubOrigin = `https://github.com/${repository}`;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positive = z.int().positive();
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const neonProjectId = z.string().regex(/^[a-z0-9-]+$/);
const origin = z.string().regex(/^https:\/\/[a-z0-9-]+\.vercel\.app$/);
const productionAliases = z.strictObject({
  "mille-hazel.vercel.app": deploymentId,
  "mille-fumin1.vercel.app": deploymentId,
  "mille-git-main-fumin1.vercel.app": deploymentId,
});
const fixedOrigin = `https://${standingPreviewAlias}` as const;
const runtimeSchema = z.object({ app: z.literal("mille"), sha });

const reason = z.enum([
  "not-observed", "waiting-for-ci", "waiting-for-production", "waiting-for-standing", "waiting-for-cleanup",
  "run-failed", "receipt-invalid", "provider-mismatch", "resources-present", "verification-error",
]);
const unavailable = z.strictObject({ status: z.enum(["pending", "failed"]), reason });
const githubEvidenceUrl = z.string().regex(/^https:\/\/github\.com\/tyask\/mille\/actions\/runs\/[1-9][0-9]*\/(?:attempts|job|artifacts)\/[1-9][0-9]*$/);
const ciDetails = z.strictObject({ runId: positive, attempt: positive, jobId: positive });

function checkSchema<T extends z.ZodType>(details: T, url: z.ZodType<string> = githubEvidenceUrl) {
  return z.union([z.strictObject({ status: z.literal("passed"), url, details }), unavailable]);
}

export const postMergeChecks = z.strictObject({
  ci: checkSchema(ciDetails),
  production: checkSchema(z.strictObject({ deploymentId, aliases: productionAliases, runtimeSha: sha }),
    z.literal("https://mille-hazel.vercel.app")),
  standing: checkSchema(z.strictObject({
    runId: positive, attempt: positive, artifactId: positive, deploymentId,
    aliasId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), origin, fixedOrigin: z.literal(fixedOrigin),
    dbProjectId: neonProjectId, branchId: z.string().regex(/^br-[a-z0-9-]+$/),
    endpointId: z.string().regex(/^ep-[a-z0-9-]+$/), runtimeSha: sha, passedCases: z.literal(4),
  })),
  cleanup: checkSchema(ciDetails.extend({ vercelProjectId: projectId, neonProjectId, headSha: sha })),
});

type Checks = z.infer<typeof postMergeChecks>;
type Unavailable = z.infer<typeof unavailable>;
type ReadGitHub = (path: string) => ReturnType<PreviewGitHubRequest>;
const notObserved = { status: "pending", reason: "not-observed" } as const;
export const emptyPostMergeChecks: Checks = { ci: notObserved, production: notObserved, standing: notObserved, cleanup: notObserved };

class EvidenceUnavailable extends Error {
  constructor(readonly result: Unavailable) {
    super(result.reason);
  }
}

function pending(value: Unavailable["reason"]): never {
  throw new EvidenceUnavailable({ status: "pending", reason: value });
}

function failed(value: Unavailable["reason"]): never {
  throw new EvidenceUnavailable({ status: "failed", reason: value });
}

async function observe<T>(inspect: () => Promise<T>): Promise<T | Unavailable> {
  try { return await inspect(); }
  catch (error) {
    if (error instanceof StandingMainCiPending) return { status: "pending", reason: "waiting-for-ci" };
    if (error instanceof StandingProductionPending) return { status: "pending", reason: "waiting-for-production" };
    if (error instanceof EvidenceUnavailable) return error.result;
    return { status: "failed", reason: "verification-error" };
  }
}

const mergedPr = z.object({
  number: positive.max(2147483647), headSha: sha, mergeSha: sha, mergedAt: z.iso.datetime(),
  headRef: z.string().max(256).refine(isNativePreviewTaskBranch),
});
const environmentConfig = z.object({
  GH_TOKEN: z.string().min(1), VERCEL_TOKEN: z.string().min(1), NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: projectId, MILLE_PR_PREVIEW_NEON_PROJECT_ID: neonProjectId,
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: z.string().regex(/^br-[a-z0-9-]+$/),
  MILLE_PR_PREVIEW_MAX_BRANCHES: z.string().regex(/^[1-9][0-9]?$/).transform(Number),
});
const runRepository = z.object({ id: z.literal(milleRepositoryId), full_name: z.literal(repository) });
const runList = z.object({ workflow_runs: z.array(z.object({
  id: positive, run_attempt: positive, head_branch: z.literal("main"), head_sha: sha,
  repository: runRepository, head_repository: runRepository, path: z.string(),
  event: z.enum(["push", "workflow_dispatch", "workflow_run"]), status: z.string(), conclusion: z.string().nullable(),
  created_at: z.iso.datetime(),
})).max(100), total_count: z.int().nonnegative() });
type Workflow = "standing-preview.yml" | "pr-preview.yml";

async function readWorkflowRuns(read: ReadGitHub, workflow: Workflow, mergeSha: string) {
  const { workflow_runs: runs, total_count: totalCount } = runList.parse(await read(
    `actions/workflows/${workflow}/runs?branch=main&head_sha=${mergeSha}&per_page=100`,
  ));
  if (totalCount !== runs.length || new Set(runs.map(({ id }) => id)).size !== runs.length
    || runs.some(run => run.head_sha !== mergeSha || !isTrustedMainWorkflowPath(run.path, workflow, mergeSha))) {
    failed("provider-mismatch");
  }
  return runs.filter(run => run.event === "push" || run.event === "workflow_dispatch").sort((a, b) => b.id - a.id);
}

const jobList = z.object({ total_count: z.int().nonnegative(), jobs: z.array(z.object({
  id: positive, run_id: positive, run_attempt: positive.optional(), head_sha: sha,
  name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })).nullish(),
})).max(100) });

async function readCleanupJob(read: ReadGitHub, pr: z.infer<typeof mergedPr>) {
  const runs = await readWorkflowRuns(read, "pr-preview.yml", pr.mergeSha);
  let encounteredFailure = false;
  for (const run of runs) {
    if (Date.parse(run.created_at) < Date.parse(pr.mergedAt)) continue;
    const { jobs, total_count: totalCount } = jobList.parse(await read(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    ));
    if (totalCount !== jobs.length || jobs.some(job => job.run_id !== run.id || job.head_sha !== pr.mergeSha
      || (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt))) {
      failed("provider-mismatch");
    }
    const matching = jobs.filter(job => job.name === `PR ${pr.number} cleanup`);
    if (matching.length > 1) failed("provider-mismatch");
    const [job] = matching;
    if (job?.status !== "completed" || run.status !== "completed") continue;
    const steps = job.steps?.filter(step => step.name === `Confirm cleanup for ${pr.headSha}`);
    if (job.conclusion === "success" && steps?.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success") {
      return { runId: run.id, attempt: run.run_attempt, jobId: job.id };
    }
    encounteredFailure = true;
  }
  if (encounteredFailure) failed("run-failed");
  return pending("waiting-for-cleanup");
}

const artifactList = z.object({ total_count: z.int().nonnegative(), artifacts: z.array(z.object({
  id: positive, name: z.string(), expired: z.boolean(), size_in_bytes: positive,
})).max(100) });
const runFile = "standing-preview-proof.json";
const maximumReceiptBytes = 16_384;
const exec = promisify(execFile);

async function downloadStandingReceipt(token: string, runId: number, name: string): Promise<unknown> {
  const path = await mkdtemp(join(tmpdir(), "mille-standing-proof-"));
  try {
    await exec("gh", ["run", "download", String(runId), "--repo", repository, "--name", name, "--dir", path], {
      env: { PATH: process.env.PATH, NODE_ENV: "production", GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeout: 30_000, maxBuffer: maximumReceiptBytes,
    });
    const file = join(path, runFile);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > maximumReceiptBytes) failed("receipt-invalid");
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return failed("receipt-invalid");
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function readStandingReceipt(read: ReadGitHub, token: string, mergeSha: string, download: typeof downloadStandingReceipt) {
  const [run] = await readWorkflowRuns(read, "standing-preview.yml", mergeSha);
  if (!run || run.status !== "completed") return pending("waiting-for-standing");
  if (run.conclusion !== "success") return failed("run-failed");
  const name = `mille-standing-preview-${run.id}-${run.run_attempt}`;
  const { artifacts, total_count: totalCount } = artifactList.parse(await read(`actions/runs/${run.id}/artifacts?name=${name}&per_page=100`));
  const [artifact] = artifacts;
  if (totalCount !== 1 || artifacts.length !== 1 || artifact.name !== name || artifact.expired
    || artifact.size_in_bytes > maximumReceiptBytes) failed("receipt-invalid");
  const parsed = standingPreviewReceiptSchema.safeParse(await download(token, run.id, name));
  if (!parsed.success) failed("receipt-invalid");
  const receipt = parsed.data;
  if (receipt.runId !== String(run.id) || receipt.runAttempt !== String(run.run_attempt) || receipt.controlSha !== mergeSha
    || receipt.release.sha !== mergeSha || receipt.browser.runtimeSha !== mergeSha || receipt.alias.origin !== fixedOrigin) failed("receipt-invalid");
  return { run, artifactId: artifact.id, receipt };
}

async function checkProductionRuntime(expected: string, request: typeof fetch) {
  const response = await request("https://mille-hazel.vercel.app/api/runtime", {
    method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) failed("provider-mismatch");
  if (runtimeSchema.parse(await response.json()).sha !== expected) pending("waiting-for-production");
}

export async function readPostMergeEvidence(pr: z.input<typeof mergedPr>, environment: Readonly<Record<string, string | undefined>>, options: {
  request?: typeof fetch; read?: ReadGitHub; download?: typeof downloadStandingReceipt;
} = {}): Promise<Checks> {
  const target = mergedPr.safeParse(pr);
  const configuration = environmentConfig.safeParse(environment);
  if (!target.success || !configuration.success) throw new Error("マージ後確認の設定が一致しません。");
  const env = configuration.data;
  const { mergeSha, headSha, number, headRef } = target.data;
  const read = options.read ?? previewGitHubRequest(env.GH_TOKEN);
  const request = options.request ?? fetch;
  const vercelConfig = { token: env.VERCEL_TOKEN, teamId: env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
    projectId: env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID };
  const standingVercel = new StandingPreviewVercel(vercelConfig, request);
  const baseline = standingVercel.readBaseline(mergeSha);
  const [ci, production, standing, cleanup] = await Promise.all([
    observe(async () => {
      const details = await readStandingMainCi(read, mergeSha);
      return { status: "passed", url: `${githubOrigin}/actions/runs/${details.runId}/attempts/${details.attempt}`, details } as const;
    }),
    observe(async () => {
      const current = await baseline;
      await checkProductionRuntime(mergeSha, request);
      const aliases = productionAliases.parse(current.productionAliases);
      return { status: "passed", url: "https://mille-hazel.vercel.app", details: {
        aliases, runtimeSha: mergeSha, deploymentId: current.productionDeploymentId,
      } } as const;
    }),
    observe(async () => {
      const { receipt, run, artifactId } = await readStandingReceipt(read, env.GH_TOKEN, mergeSha, options.download ?? downloadStandingReceipt);
      const [current, alias, deployment, db, oidc] = await Promise.all([
        baseline, standingVercel.readAlias(), standingVercel.readDeployment(receipt.release.id, mergeSha, receipt.database.endpointId),
        identifyStandingDatabase(env.NEON_API_KEY, request), readDevelopmentOidc(environment, request), standingVercel.preflight(),
      ]);
      const { projectId: dbProjectId, branchId, endpointId } = db;
      if (alias?.deploymentId !== deployment.id || alias.uid !== receipt.alias.id
        || !isDeepStrictEqual(deployment, receipt.release) || receipt.legacy.deploymentId !== current.legacyDeploymentId
        || receipt.production.deploymentId !== current.productionDeploymentId
        || !isDeepStrictEqual(receipt.production.aliases, current.productionAliases)
        || !isDeepStrictEqual(receipt.database, { projectId: dbProjectId, branchId, endpointId })) failed("provider-mismatch");
      await Promise.all([
        checkProtectedRuntime(fixedOrigin, mergeSha, oidc, request),
        checkProtectedRuntime(receipt.legacy.origin, receipt.legacy.sha, oidc, request),
      ]);
      return { status: "passed", url: `${githubOrigin}/actions/runs/${run.id}/artifacts/${artifactId}`, details: {
        runId: run.id, attempt: run.run_attempt, artifactId, deploymentId: deployment.id, aliasId: alias.uid,
        origin: deployment.origin, fixedOrigin, dbProjectId, branchId, endpointId, runtimeSha: mergeSha, passedCases: 4,
      } } as const;
    }),
    observe(async () => {
      const job = await readCleanupJob(read, target.data);
      const neon = new NeonPreview({ apiKey: env.NEON_API_KEY, projectId: env.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
        parentBranchId: env.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID, database: "mille_pr", role: "mille_pr_owner",
        maxPrBranches: env.MILLE_PR_PREVIEW_MAX_BRANCHES }, request);
      const vercel = new VercelPreview(vercelConfig, request);
      const native = /^codex\/native-preview-pilot-[ab]$/.test(headRef) ? new NativePilotVercel(vercelConfig, request) : null;
      const [deployments, branches, pilot] = await Promise.all([
        vercel.hasPrPreviewDeployments(number, headRef), neon.hasPrPreviewBranches(number, headRef),
        native?.list({ pr: number, ref: headRef, sha: headSha }),
      ]);
      if (deployments || branches || pilot?.length) failed("resources-present");
      return { status: "passed", url: `${githubOrigin}/actions/runs/${job.runId}/job/${job.jobId}`, details: {
        ...job, vercelProjectId: vercelConfig.projectId, neonProjectId: env.MILLE_PR_PREVIEW_NEON_PROJECT_ID, headSha,
      } } as const;
    }),
  ]);
  return postMergeChecks.parse({ ci, production, standing, cleanup });
}
