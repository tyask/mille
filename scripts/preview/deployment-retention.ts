import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { milleRepositoryId } from "./native-identity";

const repository = "tyask/mille";
const projectName = "mille";
const legacyStanding = {
  id: "dpl_PzqN4fUewyF6MtViekWrhWSb5juw",
  url: "mille-hypzm5ss8-fumin1.vercel.app",
} as const;
const pageLimit = 100;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const teamId = z.string().regex(/^team_[A-Za-z0-9]+$/);
const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const time = z.int().positive();
const repoId = z.union([z.literal(milleRepositoryId), z.literal(String(milleRepositoryId))]);
const terminal = z.enum(["READY", "ERROR", "CANCELED"]);
const meta = z.record(z.string(), z.unknown()).nullish();
const pagination = z.object({ count: z.int().nonnegative(), next: time.nullable() });

const project = z.object({
  id: projectId,
  accountId: teamId,
  name: z.literal(projectName),
  link: z.object({
    type: z.literal("github"), repoId, org: z.literal("tyask"), repo: z.literal(projectName),
    productionBranch: z.literal("main"),
  }),
  targets: z.record(z.string(), z.object({ id: deploymentId }).nullish()),
  crons: z.object({ deploymentId: deploymentId.nullish() }).nullish(),
});
const deploymentRow = z.object({
  uid: deploymentId, projectId, created: time, state: z.string(), target: z.string().nullish(), meta,
});
const aliasRow = z.object({
  alias: z.string().min(1), projectId, deploymentId: deploymentId.nullish(),
  deployment: z.object({ id: deploymentId }).nullish(),
});
const deploymentPages = z.object({ deployments: z.array(deploymentRow).max(pageLimit), pagination })
  .transform(data => ({ rows: data.deployments, pagination: data.pagination }));
const aliasPages = z.object({ aliases: z.array(aliasRow).max(pageLimit), pagination })
  .transform(data => ({ rows: data.aliases, pagination: data.pagination }));
const deployment = z.object({
  id: deploymentId, ownerId: teamId, projectId, name: z.literal(projectName), url: z.string(),
  createdAt: time, readyState: z.string(), target: z.string().nullish(), meta,
  gitSource: z.unknown().optional(), deletedAt: time.nullish(), softDeletedByRetention: z.boolean().optional(),
});
const githubMainSource = z.object({ type: z.literal("github"), repoId, ref: z.literal("main"), sha });
const liveAliases = z.object({
  aliases: z.array(z.object({ alias: z.string().min(1) })),
  pagination: z.object({ count: z.int().nonnegative().optional(), next: z.null().optional() }).optional(),
});

type Read = (path: string) => Promise<unknown>;
type Page<Row> = { rows: Row[]; pagination: z.infer<typeof pagination> };
type DeploymentRow = z.infer<typeof deploymentRow>;
type Candidate = { id: string; sha: string; state: z.infer<typeof terminal> };
type PlanInput = {
  controlSha: string; teamId: string; projectId: string; token: string; ancestors: ReadonlySet<string>;
};

class PlanError extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown, reason: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PlanError(reason);
  return result.data;
}

function reader(origin: string, token: string, request: typeof fetch, vercelTeam?: string): Read {
  return async path => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new PlanError("読み取り先の API が一致しません。");
    if (vercelTeam) url.searchParams.set("teamId", vercelTeam);
    try {
      const response = await request(url, {
        method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new PlanError(`管理 API の読み取りに失敗しました (HTTP ${response.status})。`);
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof PlanError) throw error;
      throw new PlanError("管理 API の応答を確認できません。");
    }
  };
}

async function listAll<Row>(read: Read, path: string, schema: z.ZodType<Page<Row>>, key: (row: Row) => string) {
  const rows = new Map<string, Row>();
  let until: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const suffix: string = until === null ? "" : `&until=${until}`;
    const result = parse(schema, await read(`${path}${suffix}`), "Vercel の一覧の形式が一致しません。");
    if (result.pagination.count !== result.rows.length) break;
    for (const row of result.rows) {
      const id = key(row);
      if (rows.has(id)) throw new PlanError("Vercel の一覧に同じ項目が複数あります。");
      rows.set(id, row);
    }
    const next: number | null = result.pagination.next;
    if (next === null) return rows;
    if (until !== null && next >= until) break;
    until = next;
  }
  throw new PlanError("Vercel の一覧を最後まで照合できません。");
}

function mainSource(metadata: z.infer<typeof meta>): string | undefined {
  if (metadata?.githubCommitRef !== "main" || metadata.githubCommitOrg !== "tyask"
    || metadata.githubCommitRepo !== projectName || !repoId.safeParse(metadata.githubRepoId).success
    || Object.keys(metadata).some(key => key.toLowerCase().startsWith("mille"))) return undefined;
  const result = sha.safeParse(metadata.githubCommitSha);
  return result.success ? result.data : undefined;
}

async function deploymentAliases(read: Read, id: string) {
  const result = parse(liveAliases, await read(`/v2/deployments/${id}/aliases`),
    "デプロイ単位のエイリアス一覧を照合できません。");
  if (result.pagination?.count !== undefined && result.pagination.count !== result.aliases.length) {
    throw new PlanError("デプロイ単位のエイリアス一覧を最後まで照合できません。");
  }
  return result.aliases;
}

async function inventory(read: Read, config: PlanInput) {
  const [p, aliases, deployments] = await Promise.all([
    read(`/v9/projects/${config.projectId}`).then(value => parse(project, value, "Vercel プロジェクトを照合できません。")),
    listAll(read, `/v4/aliases?projectId=${config.projectId}&limit=${pageLimit}`, aliasPages, row => row.alias.toLowerCase()),
    listAll(read, `/v6/deployments?projectId=${config.projectId}&limit=${pageLimit}`, deploymentPages, row => row.uid),
  ]);
  const production = p.targets.production?.id;
  if (p.id !== config.projectId || p.accountId !== config.teamId || !production
    || [...deployments.values()].some(row => row.projectId !== config.projectId)) {
    throw new PlanError("Vercel のチーム・プロジェクト・本番ターゲットが一致しません。");
  }
  const aliasRefs = [...aliases].map(([name, row]) => {
    const id = row.deploymentId ?? row.deployment?.id;
    if (!id || row.projectId !== config.projectId || (row.deploymentId && row.deployment && row.deploymentId !== row.deployment.id)) {
      throw new PlanError("Vercel のエイリアスの参照先が一致しません。");
    }
    return [name, id] as const;
  });
  const targets = Object.entries(p.targets).flatMap(([name, target]) => target ? [[name, target.id] as const] : []);
  const cron = p.crons?.deploymentId;
  const protectedIds = new Set<string>([legacyStanding.id, ...targets.map(([, id]) => id), ...aliasRefs.map(([, id]) => id)]);
  if (cron) protectedIds.add(cron);
  if ([...protectedIds].some(id => !deployments.has(id))) throw new PlanError("保持するデプロイが一覧にありません。");
  const fingerprint = JSON.stringify([
    targets.sort(), aliasRefs.sort(), cron ?? null,
    [...deployments.values()].map(row => [row.uid, row.created, row.state, row.target ?? null, mainSource(row.meta) ?? null]).sort(),
  ]);
  return { deployments, production, protectedIds, fingerprint };
}

async function exactDeployment(read: Read, row: DeploymentRow, config: PlanInput) {
  const item = parse(deployment, await read(`/v13/deployments/${row.uid}?withGitRepoInfo=true`), "Vercel のデプロイを照合できません。");
  if (item.id !== row.uid || item.ownerId !== config.teamId || item.projectId !== config.projectId
    || item.createdAt !== row.created || item.readyState !== row.state || (item.target ?? null) !== (row.target ?? null)
    || item.deletedAt != null || item.softDeletedByRetention) {
    throw new PlanError("Vercel のデプロイの所有または状態が変わりました。");
  }
  return item;
}

export async function planDeploymentRetention(
  config: PlanInput, { readMain, request = fetch }: { readMain: () => Promise<string>; request?: typeof fetch },
) {
  parse(z.object({ controlSha: sha, teamId, projectId, token: z.string().trim().min(1) }), config, "デプロイ整理の設定が足りません。");
  async function assertMain() {
    if (!config.ancestors.has(config.controlSha) || await readMain() !== config.controlSha) {
      throw new PlanError("照合対象の main が一致しません。");
    }
  }
  await assertMain();
  const read = reader("https://api.vercel.com", config.token, request, config.teamId);
  const before = await inventory(read, config);
  const standing = await exactDeployment(read, before.deployments.get(legacyStanding.id)!, config);
  if (standing.url !== legacyStanding.url || standing.readyState !== "READY"
    || (standing.target != null && standing.target !== "preview")) throw new PlanError("既存の常設 Preview を照合できません。");

  const eligible: (Candidate & { createdAt: number })[] = [];
  for (const row of before.deployments.values()) {
    const source = mainSource(row.meta);
    const state = terminal.safeParse(row.state);
    if (row.target !== "production" || !source || !state.success || !config.ancestors.has(source)) continue;
    const item = await exactDeployment(read, row, config);
    const git = githubMainSource.safeParse(item.gitSource);
    if (!git.success || git.data.sha !== source || mainSource(item.meta) !== source) {
      throw new PlanError("本番デプロイの Git ソースが一致しません。");
    }
    eligible.push({ id: item.id, sha: source, state: state.data, createdAt: item.createdAt });
  }
  eligible.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const newestReady = eligible.find(item => item.state === "READY");
  if (!newestReady || !eligible.some(item => item.id === before.production && item.state === "READY")) {
    throw new PlanError("現用の本番デプロイを照合できません。");
  }
  before.protectedIds.add(newestReady.id);

  const candidates: Candidate[] = [];
  for (const { id, sha: source, state } of eligible) {
    if (before.protectedIds.has(id)) continue;
    if (!(await deploymentAliases(read, id)).length) candidates.push({ id, sha: source, state });
  }

  const after = await inventory(read, config);
  const standingAfter = await exactDeployment(read, after.deployments.get(legacyStanding.id)!, config);
  if (after.fingerprint !== before.fingerprint || standingAfter.url !== standing.url || standingAfter.readyState !== standing.readyState) {
    throw new PlanError("デプロイまたは参照先が照合中に変わりました。");
  }
  for (const { id } of candidates) {
    if ((await deploymentAliases(read, id)).length) {
      throw new PlanError("デプロイのエイリアスが照合中に変わりました。");
    }
  }
  await assertMain();
  return {
    controlSha: config.controlSha, productionDeploymentId: before.production,
    standingDeploymentId: legacyStanding.id, newestReadyDeploymentId: newestReady.id,
    scanned: before.deployments.size, candidates,
  };
}

const workflowEnvironment = z.object({
  GITHUB_REPOSITORY: z.literal(repository), GITHUB_REF: z.literal("refs/heads/main"),
  GITHUB_WORKFLOW_REF: z.literal(`${repository}/.github/workflows/deployment-retention.yml@refs/heads/main`),
  GITHUB_EVENT_NAME: z.literal("workflow_dispatch"), GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_SHA: sha, GH_TOKEN: z.string().min(1), VERCEL_TOKEN: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: teamId, MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: projectId,
});

async function main() {
  const env = parse(workflowEnvironment, process.env, "デプロイ整理は信頼済み main の手動実行が必要です。");
  const event = z.object({ repository: z.object({ id: z.literal(milleRepositoryId), full_name: z.literal(repository) }) });
  parse(event, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")), "GitHub イベントの所属が一致しません。");
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (git(["rev-parse", "HEAD"]) !== env.GITHUB_SHA) throw new PlanError("checkout が実行元 SHA と一致しません。");
  const ancestors = new Set(git(["rev-list", env.GITHUB_SHA]).split("\n"));
  const readGitHub = reader("https://api.github.com", env.GH_TOKEN, fetch);
  const ref = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha }) });
  const result = await planDeploymentRetention({
    controlSha: env.GITHUB_SHA, teamId: env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
    projectId: env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID, token: env.VERCEL_TOKEN, ancestors,
  }, { readMain: async () => parse(ref, await readGitHub(`/repos/${repository}/git/ref/heads/main`), "GitHub の main を照合できません。").object.sha });
  const lines = [
    "## 旧デプロイの読み取り計画",
    "",
    `- main SHA \`${result.controlSha}\``,
    `- 現用本番 \`${result.productionDeploymentId}\``,
    `- 最新 READY \`${result.newestReadyDeploymentId}\``,
    `- 既存の常設 Preview \`${result.standingDeploymentId}\``,
    `- 照合 ${result.scanned}件、候補 ${result.candidates.length}件`,
    "",
    "| 候補 ID | コミット SHA | 状態 |",
    "| --- | --- | --- |",
    ...result.candidates.map(row => `| \`${row.id}\` | \`${row.sha}\` | ${row.state} |`),
  ];
  const summary = `${lines.join("\n")}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof PlanError ? error.message : "デプロイ整理の読み取り計画を完了できませんでした。");
    process.exitCode = 1;
  });
}
