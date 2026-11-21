import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { milleRepositoryId } from "./native-identity";

const projectName = "mille";
const repository = "tyask/mille";
const protocol = "mille-native-preview-pilot/v1";
const prefix = "MILLE_NATIVE_PREVIEW_";
const endpointHeader = "x-mille-native-endpoint-sha256";
const nativeVariables = new Set([
  "DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_PROJECT_ID", "PGHOST", "PGHOST_UNPOOLED",
  "PGUSER", "PGDATABASE", "PGPASSWORD", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING",
  "POSTGRES_USER", "POSTGRES_HOST", "POSTGRES_PASSWORD", "POSTGRES_DATABASE", "POSTGRES_URL_NO_SSL", "POSTGRES_PRISMA_URL",
].map(key => `${prefix}${key}`));

const teamId = z.string().regex(/^team_[A-Za-z0-9]+$/);
const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const generationId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const ref = z.enum(["codex/native-preview-pilot-a", "codex/native-preview-pilot-b"]);
const pr = z.int().positive().max(2147483647);
const time = z.int().positive();
const repositoryId = z.union([z.literal(milleRepositoryId), z.literal(String(milleRepositoryId))]);
const previewOnly = z.tuple([z.literal("preview")]);
const readyState = z.enum(["QUEUED", "INITIALIZING", "ANALYZING", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "BLOCKED"]);
const terminal = new Set<string>(["READY", "ERROR", "CANCELED", "BLOCKED"]);
const targetSchema = z.object({ pr, ref, sha });
const configSchema = z.object({
  token: z.string().min(1), teamId, projectId,
  storeId: z.string().regex(/^store_[A-Za-z0-9]+$/),
  integrationId: z.string().regex(/^icfg_[A-Za-z0-9]+$/),
  productId: z.string().regex(/^iap_[A-Za-z0-9]+$/),
  neonProjectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
});

const environment = z.object({
  key: z.string().min(1),
  target: z.array(z.enum(["production", "preview", "development"])).min(1),
  gitBranch: z.string().min(1).nullish(),
  configurationId: z.string().nullish(),
  customEnvironmentIds: z.array(z.string()).nullish(),
  contentHint: z.object({
    type: z.string(), integrationConfigurationId: z.string().optional(),
    integrationProductId: z.string().optional(), storeId: z.string().optional(),
  }).nullish(),
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
const store = z.object({ store: z.object({
  id: z.string(), name: z.literal("mille-preview"), ownerId: teamId, externalResourceId: z.string(),
  type: z.literal("integration"), status: z.literal("available"), totalConnectedProjects: z.literal(1),
  billingPlan: z.object({ id: z.literal("free_v3") }),
  product: z.object({ id: z.string(), slug: z.literal("neon"), integrationConfigurationId: z.string() }),
  projectsMetadata: z.tuple([z.object({
    projectId, environments: previewOnly, envVarPrefix: z.enum(["MILLE_NATIVE_PREVIEW", prefix]),
    environmentVariables: z.array(z.string()).min(1),
    deployments: z.object({ actions: z.tuple([z.object({ slug: z.string().min(1), environments: previewOnly })]) }),
  })]),
}) });

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
  routes: z.array(z.object({ headers: z.record(z.string(), z.string()).optional() })).nullish(),
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
const builds = z.object({
  builds: z.array(z.object({
    deploymentId, readyState: z.literal("READY"),
    output: z.array(z.object({ type: z.literal("file"), path: z.enum(["index.html", "/index.html"]), lambda: z.null().optional() })),
  })).min(1),
  pagination: completePagination,
});
const aliasDetails = z.object({
  alias: z.string(), projectId, deploymentId, redirect: z.null().optional(), redirectStatusCode: z.null().optional(),
  microfrontends: z.never().optional(), protectionBypass: z.strictObject({}).optional(),
});
const aliasList = z.object({
  aliases: z.array(z.object({ alias: z.string(), redirect: z.null().optional() })).max(1),
  pagination: completePagination,
});

export type NativePilotTarget = { pr: number; ref: string; sha: string };
export { project as nativeVercelProject, inventory as nativeVercelDeploymentInventory,
  environmentInventory as nativeVercelEnvironmentInventory };
export type NativePilotDeployment = NativePilotTarget & {
  id: string; generation: string; requestedAt: number; createdAt: number; readyAt?: number;
  endpointDigest?: string; url: string; readyState: z.infer<typeof readyState>;
};
type VerifyCurrent = () => Promise<void>;
type Config = z.infer<typeof configSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Vercel の Native 試験用構成または応答を確認できません。");
  return parsed.data;
}

function sameDeployment(a: NativePilotDeployment, b: NativePilotDeployment): boolean {
  return a.id === b.id && a.pr === b.pr && a.ref === b.ref && a.sha === b.sha && a.generation === b.generation
    && a.requestedAt === b.requestedAt && a.createdAt === b.createdAt && a.url === b.url
    && (a.readyAt === undefined || a.readyAt === b.readyAt)
    && (a.endpointDigest === undefined || a.endpointDigest === b.endpointDigest);
}

function branchAlias(branch: z.infer<typeof ref>): string {
  return `mille-git-${branch.replace("/", "-")}-fumin1.vercel.app`;
}

function isTrustedPreviewBranch(branch: string | null | undefined): boolean {
  return typeof branch === "string" && /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch) && !/^codex\//i.test(branch);
}

export function hasDetachedPreviewEnvironments(envs: readonly z.infer<typeof environment>[]): boolean {
  return envs.every(env => !env.target.includes("preview") || isTrustedPreviewBranch(env.gitBranch));
}

export class NativePilotVercel {
  private readonly config: Config;

  constructor(config: Config, private readonly request: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = delay) {
    this.config = parse(configSchema, config);
  }

  private async api(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, allowMissing = false) {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", this.config.teamId);
    let response: Response;
    try {
      response = await this.request(url, {
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
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`Vercel API ${method} が失敗しました (HTTP ${response.status})。`);
    if (method === "DELETE") return null;
    try { return await response.json() as unknown; }
    catch { throw new Error("Vercel API の応答形式を確認できません。"); }
  }

  async preflight(): Promise<void> {
    const config = this.config;
    const verifiedProject = parse(project, await this.api(`/v9/projects/${config.projectId}`));
    if (verifiedProject.id !== config.projectId || verifiedProject.accountId !== config.teamId) {
      throw new Error("Vercel プロジェクトの所有を確認できません。");
    }
    const [{ store: attached }, listed] = await Promise.all([
      this.api(`/v1/storage/stores/${config.storeId}`).then(value => parse(store, value)),
      this.api(`/v10/projects/${config.projectId}/env?decrypt=false`).then(value => parse(environmentInventory, value)),
    ]);
    const [binding] = attached.projectsMetadata;
    const keys = new Set(binding.environmentVariables);
    if (attached.id !== config.storeId || attached.ownerId !== config.teamId || attached.externalResourceId !== config.neonProjectId
      || attached.product.id !== config.productId || attached.product.integrationConfigurationId !== config.integrationId
      || binding.projectId !== config.projectId || keys.size !== binding.environmentVariables.length
      || !keys.has(`${prefix}DATABASE_URL`) || [...keys].some(key => !nativeVariables.has(key))) {
      throw new Error("Vercel の Native 試験用ストア接続を確認できません。");
    }
    const inventoryComplete = listed.pagination?.count === undefined || listed.pagination.count === listed.envs.length;
    if (!inventoryComplete || ![listed.envs, verifiedProject.env ?? []].every(envs => this.allowedEnvironments(envs, keys))) {
      throw new Error("Vercel の Native 試験に継承される環境変数を確認できません。");
    }
  }

  private allowedEnvironments(envs: z.infer<typeof environment>[], storeKeys: ReadonlySet<string>): boolean {
    const seen = new Set<string>();
    return envs.every(env => {
      if (!env.target.includes("preview")) return true;
      if (isTrustedPreviewBranch(env.gitBranch)) return true;
      const hint = env.contentHint;
      if (env.gitBranch != null || env.customEnvironmentIds?.length || env.target.length !== 1 || seen.has(env.key)
        || !storeKeys.has(env.key) || hint?.type !== "integration-store-secret" || hint.storeId !== this.config.storeId
        || hint.integrationConfigurationId !== this.config.integrationId || hint.integrationProductId !== this.config.productId
        || (env.configurationId != null && env.configurationId !== this.config.integrationId)) return false;
      seen.add(env.key);
      return true;
    });
  }

  private alias(host: string) {
    return this.api(`/v4/aliases/${host}`, "GET", undefined, true);
  }

  private async assertAliasUnassigned(branch: z.infer<typeof ref>): Promise<void> {
    if (await this.alias(branchAlias(branch)) !== null) throw new Error("Native 試験用のブランチ URL は既に割り当てられています。");
  }

  private async verifyDeploymentAlias(id: string, branch: z.infer<typeof ref>, detailAliases: readonly string[]): Promise<void> {
    const host = branchAlias(branch);
    const [list, direct] = await Promise.all([
      this.api(`/v2/deployments/${id}/aliases`).then(value => parse(aliasList, value)),
      this.alias(host),
    ]);
    const names = [...detailAliases, ...list.aliases.map(alias => alias.alias)];
    if (names.some(alias => alias !== host) || (list.pagination?.count !== undefined && list.pagination.count !== list.aliases.length)) {
      throw new Error("Native 試験用 Deployment に想定外のエイリアスがあります。");
    }
    if (direct === null && names.length === 0) return;
    const aliased = parse(aliasDetails, direct);
    if (aliased.alias !== host || aliased.projectId !== this.config.projectId || aliased.deploymentId !== id) {
      throw new Error("Native 試験用のブランチ URL の割り当てを確認できません。");
    }
  }

  private async deployment(id: string, target: NativePilotTarget, exactSha: boolean): Promise<NativePilotDeployment | null> {
    id = parse(deploymentId, id);
    const value = await this.api(`/v13/deployments/${id}?withGitRepoInfo=true`, "GET", undefined, true);
    if (value === null) return null;
    const item = parse(detailSchema, value);
    const { meta, gitSource } = item;
    if (item.id !== id || item.projectId !== this.config.projectId || item.ownerId !== this.config.teamId
      || meta.milleNativePilotPr !== String(target.pr) || meta.milleNativePilotRef !== target.ref || gitSource.ref !== target.ref
      || gitSource.sha !== meta.milleNativePilotSha || (exactSha && gitSource.sha !== target.sha)
      || meta.milleNativePilotRequestedAt > item.createdAt
      || (item.ready != null && item.ready < item.createdAt) || (item.readyState === "READY" && item.ready == null)) {
      throw new Error("Vercel の Native 試験用 Deployment の所有または Git ソースが一致しません。");
    }
    if (item.deletedAt != null || item.softDeletedByRetention === true) return null;
    await this.verifyDeploymentAlias(id, gitSource.ref, item.alias ?? []);
    const endpointDigests = (item.routes ?? []).flatMap(route => Object.entries(route.headers ?? {}))
      .filter(([name]) => name.toLowerCase() === endpointHeader).map(([, value]) => value);
    if (endpointDigests.length > 1) throw new Error("複数の Native エンドポイント確認ヘッダーがあります。");
    const endpointDigest = parse(sha256.optional(), endpointDigests[0]);
    return {
      id, pr: target.pr, ref: target.ref, sha: gitSource.sha, generation: meta.milleNativePilotGeneration,
      requestedAt: meta.milleNativePilotRequestedAt, createdAt: item.createdAt, url: `https://${item.url}`, readyState: item.readyState,
      ...(item.readyState === "READY" && item.ready != null ? { readyAt: item.ready } : {}),
      ...(endpointDigest == null ? {} : { endpointDigest }),
    };
  }

  async find(target: NativePilotTarget, exactSha = true): Promise<NativePilotDeployment | null> {
    const source = parse(targetSchema, target);
    const seen = new Set<string>();
    let match: NativePilotDeployment | null = null;
    let until: number | null = null;
    for (let page = 0; page < 100; page++) {
      const suffix: string = until === null ? "" : `&until=${until}`;
      const result = parse(inventory, await this.api(`/v6/deployments?projectId=${this.config.projectId}&limit=100${suffix}`));
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
    await this.preflight();
    if (await this.find(target)) throw new Error("Vercel の Native 試験用 Deployment は作成済みです。");
    await verifyCurrent();
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
    const { id } = parse(z.object({ id: deploymentId }), await this.api("/v13/deployments?forceNew=1", "POST", {
      name: projectName, project: this.config.projectId, public: false,
      gitSource: { type: "github", repoId: milleRepositoryId, ref: target.ref, sha: target.sha },
      env, build: { env },
      meta: {
        milleNativePilotProtocol: protocol, milleNativePilotRepository: repository, milleNativePilotPhase: "provision",
        milleNativePilotPr: String(target.pr), milleNativePilotRef: target.ref, milleNativePilotSha: target.sha,
        milleNativePilotGeneration: generation, milleNativePilotRequestedAt: String(requestedAt),
      },
    }));
    await verifyCurrent();
    const result = await this.deployment(id, target, true);
    if (!result || result.generation !== generation || result.requestedAt !== requestedAt) {
      throw new Error("作成した Vercel Deployment の世代または作成要求時刻を確認できません。");
    }
    return result;
  }

  async confirmStatic(deployment: NativePilotDeployment, verifyCurrent?: VerifyCurrent): Promise<NativePilotDeployment> {
    const target = parse(targetSchema, deployment);
    const deadline = Date.now() + 10 * 60_000;
    for (let attempt = 0; attempt < 120 && Date.now() < deadline; attempt++) {
      await verifyCurrent?.();
      const current = await this.deployment(deployment.id, target, true);
      if (!current || !sameDeployment(deployment, current)) throw new Error("準備用 Deployment の所有が変わりました。");
      if (current.readyState === "READY") {
        const output = parse(builds, await this.api(`/v11/deployments/${current.id}/builds`));
        if (!current.endpointDigest || output.builds.some(build => build.deploymentId !== current.id)
          || output.builds.flatMap(build => build.output).length !== 1
          || (output.pagination?.count !== undefined && output.pagination.count !== output.builds.length)) {
          throw new Error("Vercel の静的な準備用ビルド成果物を確認できません。");
        }
        await verifyCurrent?.();
        return current;
      }
      if (terminal.has(current.readyState)) throw new Error(`Vercel の準備用ビルドは ${current.readyState} で終了しました。`);
      await this.wait(5_000);
    }
    throw new Error("Vercel の準備用ビルドが READY になりませんでした。");
  }

  async remove(deployment: NativePilotDeployment, verifyCurrent: VerifyCurrent): Promise<void> {
    const target = parse(targetSchema, deployment);
    await verifyCurrent();
    const current = await this.deployment(deployment.id, target, true);
    if (!current) {
      await this.assertAliasUnassigned(target.ref);
      return;
    }
    if (!sameDeployment(deployment, current) || !terminal.has(current.readyState)) {
      throw new Error("Vercel の削除対象またはビルド終了を確認できません。");
    }
    await verifyCurrent();
    await this.api(`/v13/deployments/${current.id}`, "DELETE", undefined, true);
    if (await this.deployment(current.id, target, true)) throw new Error("Vercel Deployment の削除を確認できません。");
    await this.assertAliasUnassigned(target.ref);
    await verifyCurrent();
  }
}
