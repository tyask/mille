import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { previewOrigin, scopedProtectionHeaders, verifyBrowser, type BrowserProof } from "../cloud/verify";
import { milleRepositoryId } from "./native-identity";
import { identifyStandingDatabase, prepareStandingDatabase } from "./standing-database";
import { StandingAliasError, standingPreviewAlias, StandingPreviewVercel, type StandingPreviewAlias } from "./standing-vercel";
import { readPreviewTree } from "./source";
import { readDevelopmentOidc, readVerifiedBrowserEvidence } from "./verify";

const repository = "tyask/mille";
const fixedOrigin = `https://${standingPreviewAlias}`;
const legacy = {
  origin: "https://mille-hypzm5ss8-fumin1.vercel.app",
  sha: "7d8001aed54f1a1cec97f7071fbb31b4c9d99c2b",
};
const shaPattern = z.string().regex(/^[a-f0-9]{40}$/);
const runtimePayload = z.object({ app: z.literal("mille"), sha: shaPattern });

type CheckCurrent = () => Promise<void>;
type Database = Awaited<ReturnType<typeof identifyStandingDatabase>>;
type Release = Awaited<ReturnType<StandingPreviewVercel["readDeployment"]>>;
type Stage = "preflight" | "migration" | "deploy" | "browser" | "publish" | "restore-alias" | "restored-alias";
type Operations = {
  verifyCurrent: CheckCurrent;
  vercel: Pick<StandingPreviewVercel, "preflight" | "readBaseline" | "readAlias" | "deploy" | "readDeployment" | "assignAlias" | "removeAlias">;
  identifyDatabase: () => Promise<Database>;
  prepareDatabase: (database: Database, verifyCurrent: CheckCurrent) => ReturnType<typeof prepareStandingDatabase>;
  readSource: () => ReturnType<typeof readPreviewTree>;
  browse: (release: Release) => Promise<BrowserProof>;
  checkRuntime: (origin: string, sha: string) => Promise<void>;
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

export async function checkProtectedRuntime(origin: string, sha: string, token: string, request: typeof fetch = fetch) {
  if (previewOrigin(origin) !== origin) throw new Error("常設 Preview の origin が一致しません。");
  const url = new URL("/api/runtime", origin);
  const init = { method: "GET", redirect: "manual", cache: "no-store" } as const;
  const anonymous = await Promise.all([new URL("/", origin), url].map(target =>
    request(target, { ...init, signal: AbortSignal.timeout(15_000) })));
  if (!anonymous.every(protectionConfirmed)) throw new Error("常設 Preview の未認証アクセスを遮断できません。");
  const authenticated = await request(url, { ...init, redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: scopedProtectionHeaders(url.href, origin, token, "x-vercel-trusted-oidc-idp-token") });
  if (authenticated.status !== 200 || runtimePayload.parse(await authenticated.json()).sha !== sha) {
    throw new Error("常設 Preview の実行時 SHA が一致しません。");
  }
}

export async function publishFirstStandingPreview(sha: string, operations: Operations,
  report: (stage: Stage, binding?: StandingPreviewAlias) => void = () => {}) {
  const { verifyCurrent, vercel, identifyDatabase, prepareDatabase, readSource, browse, checkRuntime } = operations;
  report("preflight");
  await verifyCurrent();
  const [initialBaseline, database, originalAlias] = await Promise.all([
    vercel.readBaseline(), identifyDatabase(), vercel.readAlias(), vercel.preflight(),
  ]);
  if (initialBaseline.productionSha !== sha) throw new Error("現用本番の SHA と main が一致しません。");
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
  await checkRuntime(legacy.origin, legacy.sha);

  let release: Release;
  if (originalAlias) {
    release = await vercel.readDeployment(originalAlias.deploymentId, sha, database.endpointId);
  } else {
    const files = await readSource();
    report("migration");
    await checkBeforePublish();
    const configuration = await prepareDatabase(database, checkBeforePublish);
    report("deploy");
    release = await vercel.deploy({ sha, database: configuration, endpointId: database.endpointId, files }, checkBeforePublish);
  }

  if (release.sha !== sha || release.origin === fixedOrigin || release.origin === legacy.origin
    || Object.hasOwn(initialBaseline.productionAliases, new URL(release.origin).hostname)) {
    throw new Error("常設 Preview の固有 URL が一致しません。");
  }
  report("browser");
  await checkBeforePublish();
  const browser = readVerifiedBrowserEvidence(sha, release, await browse(release));
  const checkRelease = async () => {
    if (!isDeepStrictEqual(release, await vercel.readDeployment(release.id, sha, database.endpointId))) {
      throw new Error("常設 Preview のデプロイが変わりました。");
    }
  };
  await checkRelease();
  await checkRuntime(legacy.origin, legacy.sha);
  await checkBeforePublish();

  report("publish");
  let alias = originalAlias;
  let createdAlias: StandingPreviewAlias | undefined;
  try {
    alias ??= await vercel.assignAlias(release.id, async () => {
      await checkRelease();
      await checkBeforePublish();
    }, created => { createdAlias = created; });
    if (alias.deploymentId !== release.id) throw new Error("固定 URL が想定外のデプロイを参照しています。");
    await checkRuntime(fixedOrigin, sha);
    await checkBaseline();
    await checkRelease();
    if (!isDeepStrictEqual(alias, await vercel.readAlias())) throw new Error("固定 URL の割り当てが一致しません。");
  } catch (error) {
    if (createdAlias?.deploymentId === release.id) {
      report("restore-alias", createdAlias);
      await vercel.removeAlias(createdAlias, checkRelease);
      if (await vercel.readAlias()) throw new Error("固定 URL の割り当てを復元できません。");
      report("restored-alias", createdAlias);
    }
    throw error;
  }
  return {
    controlSha: sha,
    production: { deploymentId: initialBaseline.productionDeploymentId, aliases: initialBaseline.productionAliases },
    legacy: { deploymentId: initialBaseline.legacyDeploymentId, ...legacy },
    release,
    database: { projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId },
    alias: { origin: fixedOrigin, id: alias.uid },
    browser,
  };
}

const envSchema = z.object({
  GITHUB_REPOSITORY: z.literal(repository), GITHUB_REF: z.literal("refs/heads/main"),
  GITHUB_WORKFLOW_REF: z.literal(`${repository}/.github/workflows/standing-preview.yml@refs/heads/main`),
  GITHUB_EVENT_NAME: z.literal("workflow_dispatch"), GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_SHA: shaPattern, MILLE_STANDING_PREVIEW_SHA: shaPattern,
  GITHUB_RUN_ID: z.string().regex(/^[1-9][0-9]*$/), GITHUB_RUN_ATTEMPT: z.string().regex(/^[1-9][0-9]*$/),
  GH_TOKEN: z.string().min(1), NEON_API_KEY: z.string().min(1), VERCEL_TOKEN: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
});
const eventSchema = z.object({ repository: z.object({ id: z.literal(milleRepositoryId), full_name: z.literal(repository) }) });
const mainRef = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha: shaPattern }) });
const runList = z.object({ workflow_runs: z.array(z.object({
  id: z.int().positive(), run_attempt: z.int().positive(), head_branch: z.literal("main"), head_sha: shaPattern,
  event: z.literal("push"), status: z.string(), conclusion: z.string().nullable(), path: z.literal(".github/workflows/ci.yml"),
})) });
const jobList = z.object({ jobs: z.array(z.object({
  name: z.string(), status: z.string(), conclusion: z.string().nullable(),
})) });

async function main() {
  const env = envSchema.parse(process.env);
  eventSchema.parse(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")));
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (env.GITHUB_SHA !== env.MILLE_STANDING_PREVIEW_SHA || git(["rev-parse", "HEAD"]) !== env.GITHUB_SHA
    || git(["status", "--porcelain=v1"])) throw new Error("信頼済み main の checkout が一致しません。");
  const sha = env.GITHUB_SHA;
  const read = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error("GitHub の main または CI を取得できません。");
    return response.json() as Promise<unknown>;
  };
  const verifyCurrent = async () => {
    if (mainRef.parse(await read("git/ref/heads/main")).object.sha !== sha) throw new Error("確認中に main が変わりました。");
  };
  await verifyCurrent();
  const run = runList.parse(await read(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=10`)).workflow_runs[0];
  if (!run || run.head_sha !== sha || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("現 main の CI が成功していません。");
  }
  const { jobs } = jobList.parse(await read(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`));
  if (jobs.filter(job => job.name === "check").length !== 1
    || !jobs.some(job => job.name === "check" && job.status === "completed" && job.conclusion === "success")) {
    throw new Error("現 main の CI check が一致しません。");
  }
  const vercel = new StandingPreviewVercel({
    token: env.VERCEL_TOKEN, teamId: env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID, projectId: env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID,
  });
  await mkdir(".mille/cloud", { recursive: true, mode: 0o700 });
  const phases: Stage[] = [];
  try {
    const result = await publishFirstStandingPreview(sha, {
      verifyCurrent,
      vercel,
      identifyDatabase: () => identifyStandingDatabase(env.NEON_API_KEY),
      prepareDatabase: (identity, verify) => prepareStandingDatabase(env.NEON_API_KEY, identity, { verifyCurrent: verify }),
      readSource: () => readPreviewTree(process.cwd(), sha),
      browse: async target => verifyBrowser([], { origin: target.origin, sha: target.sha, token: await readDevelopmentOidc(env) }),
      checkRuntime: async (origin, sha) => checkProtectedRuntime(origin, sha, await readDevelopmentOidc(env)),
    }, (stage, binding) => {
      phases.push(stage);
      console.log(`常設 Preview の工程 ${stage}${binding ? ` ${JSON.stringify(binding)}` : ""}`);
    });
    const receipt = JSON.stringify({ protocol: "mille-standing-preview/v1", runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT, ci: { runId: run.id, attempt: run.run_attempt }, ...result });
    await writeFile(".mille/cloud/standing-preview-proof.json", `${receipt}\n`, { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `常設 Preview 初回切替\n\n\`\`\`json\n${receipt}\n\`\`\`\n`);
    }
  } catch (error) {
    if (error instanceof StandingAliasError) console.error(`固定 URL の照合結果 ${JSON.stringify(error.receipt)}`);
    console.error(`常設 Preview の処理を停止しました（${phases.at(-1) ?? "preflight"}）。`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("信頼済み main と CI を照合できませんでした。");
    process.exitCode = 1;
  });
}
