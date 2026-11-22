import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { milleRepositoryId } from "./native-identity";
import { nativePilotStage, NativePilotHttpError } from "./native-pilot-diagnostics";

const projectName = "mille";
const repository = "tyask/mille";
const protocol = "mille-native-preview-pilot/v1";
const prefix = "MILLE_NATIVE_PREVIEW_";
const nativeDatabaseUrl = `${prefix}DATABASE_URL`;
const buildEvidenceLabel = "Mille: Native Preview 静的ビルド照合";
const buildEventLimit = 200;
const nativeVariables = new Set([
  "DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_PROJECT_ID", "PGHOST", "PGHOST_UNPOOLED",
  "PGUSER", "PGDATABASE", "PGPASSWORD", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING",
  "POSTGRES_USER", "POSTGRES_HOST", "POSTGRES_PASSWORD", "POSTGRES_DATABASE", "POSTGRES_URL_NO_SSL", "POSTGRES_PRISMA_URL",
].map(key => `${prefix}${key}`));

const teamId = z.string().regex(/^team_[A-Za-z0-9]+$/);
const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const endpointId = z.string().refine(value =>
  /^ep-[a-z0-9][a-z0-9-]{0,56}$/.test(value) && value === value.trim() && !value.endsWith("-pooler"));
const generationId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const ref = z.enum(["codex/native-preview-pilot-a", "codex/native-preview-pilot-b"]);
const pr = z.int().positive().max(2147483647);
const time = z.int().positive();
const repositoryId = z.union([z.literal(milleRepositoryId), z.literal(String(milleRepositoryId))]);
const readyState = z.enum(["QUEUED", "INITIALIZING", "ANALYZING", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "BLOCKED"]);
const terminal = new Set<string>(["READY", "ERROR", "CANCELED", "BLOCKED"]);
const targetSchema = z.object({ pr, ref, sha });
const configSchema = z.object({
  token: z.string().min(1), teamId, projectId,
});

const environment = z.object({
  key: z.string().min(1),
  target: z.array(z.enum(["production", "preview", "development"])).min(1),
  gitBranch: z.string().min(1).nullish(),
  customEnvironmentIds: z.array(z.string()).nullish(),
  contentHint: z.object({ type: z.string() }).nullish(),
});
const project = z.object({
  id: projectId, name: z.literal(projectName), accountId: teamId,
  link: z.object({ type: z.literal("github"), repoId: repositoryId, productionBranch: z.literal("main") }),
  framework: z.literal("nextjs"), nodeVersion: z.literal("24.x"),
  rootDirectory: z.null().optional(), autoExposeSystemEnvs: z.literal(true), paused: z.literal(false).optional(),
  buildCommand: z.literal("npm run build:vercel").nullish(), outputDirectory: z.null().optional(),
  installCommand: z.null().optional(), commandForIgnoringBuildStep: z.null().optional(),
  ssoProtection: z.object({ deploymentType: z.enum(["all_except_custom_domains", "prod_deployment_urls_and_all_previews", "all", "preview"]) }),
  protectionBypass: z.strictObject({}).optional(),
  env: z.array(environment).optional(), integrations: z.tuple([]).nullish(),
  connectBuildsEnabled: z.literal(false).optional(), connectConfigurationId: z.null().optional(),
  connectConfigurations: z.tuple([]).nullish(), passiveConnectConfigurationId: z.null().optional(),
});
const pagination = z.object({ count: z.int().nonnegative(), next: time.nullable() });
const completePagination = z.object({ next: z.null().optional(), count: z.int().nonnegative().optional() }).optional();
const environmentInventory = z.object({ envs: z.array(environment), pagination: completePagination });
const markerSchema = z.object({
  milleNativePilotProtocol: z.literal(protocol), milleNativePilotRepository: z.literal(repository),
  milleNativePilotPhase: z.literal("provision"), milleNativePilotPr: z.string(), milleNativePilotRef: ref,
  milleNativePilotSha: sha, milleNativePilotGeneration: generationId,
  milleNativePilotRequestedAt: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(time),
});
const detailSchema = z.object({
  id: deploymentId, ownerId: teamId, projectId, name: z.literal(projectName),
  url: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/),
  target: z.literal("preview").nullish(), public: z.literal(false), customEnvironment: z.null().optional(),
  alias: z.array(z.string()).max(1).optional(), createdAt: time, ready: time.nullish(), readyState, meta: markerSchema,
  deletedAt: time.nullish(), softDeletedByRetention: z.boolean().optional(),
  gitSource: z.object({ type: z.literal("github"), repoId: repositoryId, ref, sha }),
  functions: z.strictObject({}).nullish(), crons: z.tuple([]).nullish(),
});
const inventory = z.object({
  deployments: z.array(z.object({
    uid: deploymentId, projectId,
    gitSource: z.object({ ref: z.string().optional() }).nullish(),
    meta: z.object({
      githubCommitRef: z.string().optional(), gitCommitRef: z.string().optional(),
      millePreviewPr: z.string().optional(), milleNativePilotPr: z.string().optional(), milleNativePilotRef: z.string().optional(),
    }).nullish(),
  })).max(100),
  pagination,
});
// A result at the requested limit cannot establish that the marker is unique.
const buildEvents = z.array(z.object({
  text: z.string().nullish(), deploymentId: z.unknown().optional(),
  type: z.unknown().optional(), info: z.unknown().optional(),
})).max(buildEventLimit - 1);
const buildEvidenceEvent = z.object({
  text: z.string(), deploymentId, type: z.literal("stdout"), info: z.object({ type: z.literal("build") }),
});
const aliasUid = z.string().max(128).refine(value =>
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) && value === value.trim());
const aliasDetails = z.object({
  alias: z.string(), uid: aliasUid, projectId, deploymentId, redirect: z.null().optional(), redirectStatusCode: z.null().optional(),
  microfrontends: z.never().optional(), protectionBypass: z.strictObject({}).optional(),
});
const aliasList = z.object({
  aliases: z.array(z.object({ alias: z.string(), redirect: z.null().optional() })).max(1),
  pagination: completePagination,
});
const createRejectionLabels = new Map([
  ["missing_files", "デプロイに必要なファイルが不足"],
  ["no_files", "デプロイ対象のファイルが空"],
  ["env_too_many_keys", "環境変数の件数上限を超過"],
]);
const createRejection = z.object({
  error: z.object({ code: z.string() }),
}).transform(({ error }) => createRejectionLabels.get(error.code));

export type NativePilotTarget = { pr: number; ref: string; sha: string };
export { inventory as nativeVercelDeploymentInventory };
export type NativePilotDeployment = NativePilotTarget & {
  id: string; generation: string; requestedAt: number; createdAt: number; readyAt?: number;
  url: string; readyState: z.infer<typeof readyState>;
};
type VerifyCurrent = () => Promise<void>;
type Config = z.infer<typeof configSchema>;
type Method = "GET" | "POST" | "DELETE";

function parse<T>(schema: z.ZodType<T>, value: unknown, status?: number): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const message = "Vercel の Native 試験用構成または応答を確認できません。";
    throw status === undefined ? new Error(message) : new NativePilotHttpError(message, status);
  }
  return parsed.data;
}

function verifyStatus(response: Response, method: Method): void {
  if (!response.ok) {
    throw new NativePilotHttpError(`Vercel API ${method} が失敗しました (HTTP ${response.status})。`, response.status);
  }
}

async function verifyCreateStatus(response: Response): Promise<void> {
  if (response.status === 400) {
    const { data: label } = createRejection.safeParse(await response.json().catch(() => undefined));
    if (label) console.log(`Native Preview 診断 Vercel のデプロイ作成要求（${label}） (HTTP ${response.status})。`);
  }
  verifyStatus(response, "POST");
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new NativePilotHttpError("Vercel API の応答形式を確認できません。", response.status); }
}

function sameDeployment(a: NativePilotDeployment, b: NativePilotDeployment): boolean {
  return a.id === b.id && a.pr === b.pr && a.ref === b.ref && a.sha === b.sha && a.generation === b.generation
    && a.requestedAt === b.requestedAt && a.createdAt === b.createdAt && a.url === b.url
    && (a.readyAt === undefined || a.readyAt === b.readyAt);
}

function branchAlias(branch: z.infer<typeof ref>): string {
  return `mille-git-${branch.replace("/", "-")}-fumin1.vercel.app`;
}

function isTrustedPreviewBranch(branch: string | null | undefined): boolean {
  return typeof branch === "string" && /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch) && !/^codex\//i.test(branch);
}

function hasDetachedPreviewEnvironments(envs: readonly z.infer<typeof environment>[]): boolean {
  return envs.every(env => !env.key.startsWith(prefix)
    && (!env.target.includes("preview") || isTrustedPreviewBranch(env.gitBranch)));
}

export function detachedNativeVercelProject(team: string, id: string) {
  return project.refine(value => value.id === id && value.accountId === team
    && hasDetachedPreviewEnvironments(value.env ?? []));
}

const completeEnvironmentInventory = environmentInventory.refine(({ envs, pagination: page }) =>
  page?.count === undefined || page.count === envs.length);

export const detachedNativeVercelEnvironmentInventory = completeEnvironmentInventory.refine(({ envs }) =>
  hasDetachedPreviewEnvironments(envs));

function nativeEnvironmentKeys(envs: readonly z.infer<typeof environment>[]): Set<string> | null {
  const keys = new Set<string>();
  for (const env of envs) {
    const preview = env.target.includes("preview");
    if (!env.key.startsWith(prefix) && (!preview || isTrustedPreviewBranch(env.gitBranch))) continue;
    if (!nativeVariables.has(env.key) || !preview || env.target.length !== 1 || env.gitBranch != null || env.customEnvironmentIds?.length
      || keys.has(env.key) || env.contentHint?.type !== "integration-store-secret") return null;
    keys.add(env.key);
  }
  return keys;
}

export class NativePilotVercel {
  private readonly config: Config;

  constructor(config: Config, private readonly request: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = delay) {
    this.config = parse(configSchema, config);
  }

  private async send(path: string, method: Method, body?: unknown): Promise<Response> {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", this.config.teamId);
    try {
      return await this.request(url, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.config.token}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Vercel API ${method} の応答を確認できません。`);
    }
  }

  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.send(path, "GET");
    verifyStatus(response, "GET");
    return parse(schema, await readJson(response), response.status);
  }

  async preflight(): Promise<void> {
    const config = this.config;
    const verifiedProject = await this.read(`/v9/projects/${config.projectId}`, project);
    if (verifiedProject.id !== config.projectId || verifiedProject.accountId !== config.teamId) {
      throw new Error("Vercel プロジェクトの所有を確認できません。");
    }
    const listed = await this.read(`/v10/projects/${config.projectId}/env?decrypt=false`, completeEnvironmentInventory);
    if (!nativeEnvironmentKeys(listed.envs)?.has(nativeDatabaseUrl)
      || nativeEnvironmentKeys(verifiedProject.env ?? []) === null) {
      throw new Error("Vercel の Native 試験に継承される環境変数を確認できません。");
    }
  }

  private async alias(host: string) {
    const response = await this.send(`/v4/aliases/${host}`, "GET");
    if (response.status === 404) return { status: response.status, value: null };
    verifyStatus(response, "GET");
    const value = await readJson(response);
    if (value === null) {
      throw new NativePilotHttpError("Vercel のエイリアス応答を確認できません。", response.status);
    }
    return { status: response.status, value };
  }

  private async assertAliasUnassigned(branch: z.infer<typeof ref>): Promise<void> {
    if ((await this.alias(branchAlias(branch))).value !== null) {
      throw new Error("Native 試験用のブランチ URL は既に割り当てられています。");
    }
  }

  private ownedAliasUid(host: string, id: string, direct: { status: number; value: unknown }): string {
    const aliased = parse(aliasDetails, direct.value, direct.status);
    if (aliased.alias !== host || aliased.projectId !== this.config.projectId || aliased.deploymentId !== id) {
      throw new NativePilotHttpError("Native 試験用のブランチ URL の割り当てを確認できません。", direct.status);
    }
    return aliased.uid;
  }

  private async verifyDeploymentAlias(id: string, branch: z.infer<typeof ref>, detailAliases: readonly string[]): Promise<void> {
    const host = branchAlias(branch);
    const [list, direct] = await Promise.all([
      this.read(`/v2/deployments/${id}/aliases`, aliasList),
      this.alias(host),
    ]);
    const names = [...detailAliases, ...list.aliases.map(alias => alias.alias)];
    if (names.some(alias => alias !== host) || (list.pagination?.count !== undefined && list.pagination.count !== list.aliases.length)) {
      throw new Error("Native 試験用 Deployment に想定外のエイリアスがあります。");
    }
    if (direct.value === null && names.length === 0) return;
    this.ownedAliasUid(host, id, direct);
  }

  private async deployment(
    id: string, target: NativePilotTarget, exactSha: boolean, { allowMissing = false } = {},
  ): Promise<NativePilotDeployment | null> {
    id = parse(deploymentId, id);
    const response = await this.send(`/v13/deployments/${id}?withGitRepoInfo=true`, "GET");
    if (allowMissing && response.status === 404) return null;
    verifyStatus(response, "GET");
    const item = parse(detailSchema, await readJson(response), response.status);
    const { meta, gitSource } = item;
    if (item.id !== id || item.projectId !== this.config.projectId || item.ownerId !== this.config.teamId
      || meta.milleNativePilotPr !== String(target.pr) || meta.milleNativePilotRef !== target.ref || gitSource.ref !== target.ref
      || gitSource.sha !== meta.milleNativePilotSha || (exactSha && gitSource.sha !== target.sha)
      || meta.milleNativePilotRequestedAt > item.createdAt
      || (item.ready != null && item.ready < item.createdAt) || (item.readyState === "READY" && item.ready == null)) {
      throw new NativePilotHttpError("Vercel の Native 試験用 Deployment の所有または Git ソースが一致しません。", response.status);
    }
    if (item.deletedAt != null || item.softDeletedByRetention === true) {
      if (allowMissing) return null;
      throw new NativePilotHttpError("対象の Vercel Deployment は削除済みです。", response.status);
    }
    await this.verifyDeploymentAlias(id, gitSource.ref, item.alias ?? []);
    return {
      id, pr: target.pr, ref: target.ref, sha: gitSource.sha, generation: meta.milleNativePilotGeneration,
      requestedAt: meta.milleNativePilotRequestedAt, createdAt: item.createdAt, url: `https://${item.url}`, readyState: item.readyState,
      ...(item.readyState === "READY" && item.ready != null ? { readyAt: item.ready } : {}),
    };
  }

  async find(target: NativePilotTarget, exactSha = true): Promise<NativePilotDeployment | null> {
    const source = parse(targetSchema, target);
    const seen = new Set<string>();
    let match: NativePilotDeployment | null = null;
    let until: number | null = null;
    for (let page = 0; page < 100; page++) {
      const suffix: string = until === null ? "" : `&until=${until}`;
      const result = await this.read(`/v6/deployments?projectId=${this.config.projectId}&limit=100${suffix}`, inventory);
      if (result.pagination.count !== result.deployments.length) break;
      for (const item of result.deployments) {
        if (item.projectId !== this.config.projectId || seen.has(item.uid)) {
          throw new Error("Vercel Deployment の一覧が一致しません。");
        }
        seen.add(item.uid);
        const meta = item.meta;
        if (item.gitSource?.ref !== source.ref && meta?.githubCommitRef !== source.ref && meta?.gitCommitRef !== source.ref
          && meta?.milleNativePilotRef !== source.ref && meta?.milleNativePilotPr !== String(source.pr)
          && meta?.millePreviewPr !== String(source.pr)) continue;
        const current = await this.deployment(item.uid, source, exactSha);
        if (!current) throw new Error("Native 試験用 ref に一致する Vercel Deployment の情報を取得できません。");
        if (match) throw new Error("同じ PR の Native 試験用 Deployment が複数あります。");
        match = current;
      }
      const next: number | null = result.pagination.next;
      if (next === null) {
        if (match === null) await this.assertAliasUnassigned(source.ref);
        return match;
      }
      if (until !== null && next >= until) break;
      until = next;
    }
    throw new Error("Vercel Deployment の一覧を最後まで確認できません。");
  }

  async provision(target: NativePilotTarget, generation: string, verifyCurrent: VerifyCurrent): Promise<NativePilotDeployment> {
    target = parse(targetSchema, target);
    generation = parse(generationId, generation);
    await nativePilotStage("vercel-preflight", () => this.preflight());
    await nativePilotStage("vercel-inventory", async () => {
      if (await this.find(target)) throw new Error("Vercel の Native 試験用 Deployment は作成済みです。");
    });
    await nativePilotStage("github-target", verifyCurrent);
    const requestedAt = Date.now();
    const env = {
      AUTH_MODE: "test",
      MILLE_NATIVE_PREVIEW_PHASE: "provision",
      MILLE_NATIVE_PREVIEW_PR: String(target.pr),
      MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: target.ref,
      MILLE_NATIVE_PREVIEW_SOURCE_SHA: target.sha,
      MILLE_NATIVE_PREVIEW_GENERATION: generation,
      MILLE_NATIVE_PREVIEW_ATTEST_ENDPOINT: "1",
    };
    const body = {
      name: projectName, project: this.config.projectId,
      gitSource: { type: "github", repoId: milleRepositoryId, ref: target.ref, sha: target.sha },
      env, build: { env },
      meta: {
        milleNativePilotProtocol: protocol, milleNativePilotRepository: repository, milleNativePilotPhase: "provision",
        milleNativePilotPr: String(target.pr), milleNativePilotRef: target.ref, milleNativePilotSha: target.sha,
        milleNativePilotGeneration: generation, milleNativePilotRequestedAt: String(requestedAt),
      },
    };
    const response = await nativePilotStage("vercel-create-request", async () => {
      console.log("Native Preview 診断 Vercel のデプロイ作成要求を開始しました。");
      const result = await this.send("/v13/deployments?forceNew=1", "POST", body);
      await verifyCreateStatus(result);
      return result;
    });
    const { id } = await nativePilotStage("vercel-create-response", async () =>
      parse(z.object({ id: deploymentId }), await readJson(response), response.status));
    console.log(`Native Preview 診断 Vercel のデプロイ作成応答を受領しました (HTTP ${response.status})。`);
    await nativePilotStage("github-target", verifyCurrent);
    return nativePilotStage("vercel-create-response", async () => {
      const result = await this.deployment(id, target, true);
      if (!result || result.generation !== generation || result.requestedAt !== requestedAt) {
        throw new Error("作成した Vercel Deployment の世代または作成要求時刻を確認できません。");
      }
      return result;
    });
  }

  private async readBuildEndpoint(deployment: NativePilotDeployment): Promise<string | undefined> {
    const { id, pr, ref, sha, generation } = deployment;
    const path = `/v3/deployments/${id}/events?builds=1&follow=0&direction=forward&limit=${buildEventLimit}`;
    const events = await this.read(path, buildEvents);
    const markers = events.filter(event => event.text?.includes(buildEvidenceLabel));
    if (markers.length === 0) return undefined;
    const marker = buildEvidenceEvent.safeParse(markers[0]);
    const expected = `${buildEvidenceLabel} v1 ${id} ${pr} ${ref} ${sha} ${generation} `;
    if (markers.length !== 1 || !marker.success || marker.data.deploymentId !== id
      || !marker.data.text.startsWith(expected)) {
      throw new Error("Vercel の静的な準備用ビルド照合記録が一致しません。");
    }
    const endpoint = endpointId.safeParse(marker.data.text.slice(expected.length));
    if (!endpoint.success) throw new Error("Vercel の静的な準備用ビルド接続先を照合できません。");
    return endpoint.data;
  }

  async confirmStatic(
    deployment: NativePilotDeployment, verifyCurrent?: VerifyCurrent,
  ): Promise<NativePilotDeployment & { endpointId: string }> {
    const target = parse(targetSchema, deployment);
    const deadline = Date.now() + 10 * 60_000;
    let previous = deployment;
    for (let attempt = 0; attempt < 120 && Date.now() < deadline; attempt++) {
      await verifyCurrent?.();
      const current = await this.deployment(deployment.id, target, true);
      if (!current || !sameDeployment(previous, current)) throw new Error("準備用 Deployment の所有が変わりました。");
      previous = current;
      if (current.readyState === "READY") {
        const endpointId = await this.readBuildEndpoint(current);
        if (endpointId !== undefined) {
          await verifyCurrent?.();
          return { ...current, endpointId };
        }
      } else if (terminal.has(current.readyState)) {
        throw new Error(`Vercel の準備用ビルドは ${current.readyState} で終了しました。`);
      }
      await this.wait(5_000);
    }
    if (previous.readyState === "READY") throw new Error("Vercel の静的な準備用ビルド照合記録を確認できません。");
    throw new Error("Vercel の準備用ビルドが READY になりませんでした。");
  }

  async remove(deployment: NativePilotDeployment, verifyCurrent: VerifyCurrent): Promise<void> {
    const target = parse(targetSchema, deployment);
    await verifyCurrent();
    const current = await this.deployment(deployment.id, target, true, { allowMissing: true });
    if (!current) {
      await this.assertAliasUnassigned(target.ref);
      return;
    }
    if (!sameDeployment(deployment, current) || !terminal.has(current.readyState)) {
      throw new Error("Vercel の削除対象またはビルド終了を確認できません。");
    }
    const host = branchAlias(target.ref);
    const direct = await this.alias(host);
    if (direct.value !== null) {
      const uid = this.ownedAliasUid(host, current.id, direct);
      await verifyCurrent();
      const aliasRemoved = await this.send(`/v2/aliases/${uid}`, "DELETE");
      if (aliasRemoved.status !== 404) verifyStatus(aliasRemoved, "DELETE");
    }
    await this.assertAliasUnassigned(target.ref);
    await verifyCurrent();
    const response = await this.send(`/v13/deployments/${current.id}`, "DELETE");
    if (response.status !== 404) verifyStatus(response, "DELETE");
    if (await this.deployment(current.id, target, true, { allowMissing: true })) {
      throw new Error("Vercel Deployment の削除を確認できません。");
    }
    await this.assertAliasUnassigned(target.ref);
    await verifyCurrent();
  }
}
