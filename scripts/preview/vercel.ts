import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { previewDatabaseEnvironmentId } from "./database";

const projectName = "mille-pr-preview";
const repository = "tyask/mille";
const protocol = "mille-pr-preview/v1";
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const previewTarget = z.literal("preview").nullish();

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  link: z.unknown().nullish(),
  framework: z.string().nullish(),
  nodeVersion: z.string(),
  rootDirectory: z.string().nullish(),
  autoExposeSystemEnvs: z.boolean().optional(),
  ssoProtection: z.object({ deploymentType: z.string() }).nullish(),
  env: z.array(z.unknown()).optional(),
  integrations: z.array(z.unknown()).optional(),
  connectBuildsEnabled: z.boolean().optional(),
  connectConfigurationId: z.string().nullish(),
  connectConfigurations: z.array(z.unknown()).nullish(),
  passiveConnectConfigurationId: z.string().nullish(),
  paused: z.boolean().optional(),
});

const pagination = z.object({
  count: z.number().int().nonnegative(),
  next: z.number().int().positive().nullable(),
});
const inventory = z.object({
  deployments: z.array(z.object({
    projectId: z.string(),
    uid: deploymentId,
    meta: z.object({ millePreviewPr: z.string().optional() }).optional(),
  })),
  pagination,
});
const detailSchema = z.object({
  id: deploymentId,
  projectId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  url: z.string().regex(/^mille-pr-preview-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?\.vercel\.app$/),
  target: previewTarget,
  customEnvironment: z.unknown().nullish(),
  public: z.literal(false),
  deletedAt: z.number().int().positive().nullish(),
  softDeletedByRetention: z.boolean().optional(),
  createdAt: z.number().int().positive(),
  readyState: z.enum([
    "QUEUED", "INITIALIZING", "ANALYZING", "BUILDING", "DEPLOYING", "READY",
    "ERROR", "CANCELED", "BLOCKED",
  ]),
  meta: z.object({
    millePreviewProtocol: z.literal(protocol),
    millePreviewRepository: z.literal(repository),
    millePreviewPr: z.string(),
    millePreviewSha: sha,
    millePreviewDbHostHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
type Deployment = z.infer<typeof detailSchema>;

export type PreviewSourceFile = { file: string; data: Buffer };
type VercelConfig = { token: string; projectId: string; teamId: string };
type PreviewDatabase = { connectionString: string; expectedHost: string };
type VerifyCurrent = () => Promise<void>;

const noOp = async () => {};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Vercel API の応答形式を確認できません。");
  return result.data;
}

function validateSource(files: readonly PreviewSourceFile[]) {
  if (!files.some(({ file }) => file === "package.json")) throw new Error("Preview のソースが不足しています。");
  if (files.some(({ file }) => /^(?:now\.json|vercel\.(?:ts|js|mts|mjs|cts|cjs))$/i.test(file))) {
    throw new Error("Preview では実行形式または旧形式の Vercel 設定を使用できません。");
  }
  const config = files.find(({ file }) => file === "vercel.json");
  if (!config) return;
  let settings: unknown;
  try { settings = JSON.parse(config.data.toString("utf8")); }
  catch { throw new Error("Preview の vercel.json を読み取れません。"); }
  const result = z.object({
    env: z.never().optional(),
    build: z.object({ env: z.never().optional() }).optional(),
    public: z.literal(false).optional(),
    relatedProjects: z.never().optional(),
  }).safeParse(settings);
  if (!result.success) throw new Error("Preview の vercel.json に資格情報や公開範囲に影響する設定があります。");
}

function terminal(state: Deployment["readyState"]) {
  return ["READY", "ERROR", "CANCELED", "BLOCKED"].includes(state);
}

export class VercelPreview {
  constructor(
    private readonly config: VercelConfig,
    private readonly request: typeof fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = delay,
  ) {
    if (!/^prj_[A-Za-z0-9]+$/.test(config.projectId) || !/^team_[A-Za-z0-9]+$/.test(config.teamId)
      || !config.token) throw new Error("専用 Preview の Vercel 設定が不足しています。");
  }

  private async api(path: string, method = "GET", body?: unknown, allowMissing = false): Promise<unknown> {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", this.config.teamId);
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Vercel API ${method} の応答を確認できません。`);
    }
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`Vercel API ${method} が失敗しました (HTTP ${response.status})。`);
    if (method === "DELETE") return null;
    try { return await response.json(); }
    catch { throw new Error("Vercel API の応答形式を確認できません。"); }
  }

  private async project() {
    const project = parse(projectSchema, await this.api(`/v9/projects/${this.config.projectId}`));
    if (project.id !== this.config.projectId || project.accountId !== this.config.teamId || project.name !== projectName) {
      throw new Error("Vercel 専用 Preview プロジェクトの所有を確認できません。");
    }
    return project;
  }

  async preflight(): Promise<void> {
    const project = await this.project();
    const protectedTypes = ["all_except_custom_domains", "prod_deployment_urls_and_all_previews", "all", "preview"];
    if (project.link != null || project.framework !== "nextjs" || project.nodeVersion !== "24.x"
      || project.rootDirectory != null || project.autoExposeSystemEnvs !== true || project.paused
      || !protectedTypes.includes(project.ssoProtection?.deploymentType ?? "")) {
      throw new Error("Vercel 専用 Preview の Git 接続、ビルド設定、または Deployment Protection を確認してください。");
    }
    const environment = parse(z.object({
      envs: z.array(z.unknown()),
      hiddenProductionEnvCount: z.number().int().nonnegative().optional(),
      pagination: pagination.optional(),
    }), await this.api(`/v10/projects/${this.config.projectId}/env?decrypt=false`));
    if (environment.envs.length || environment.hiddenProductionEnvCount || environment.pagination?.next != null
      || (environment.pagination?.count ?? 0) !== 0 || project.env?.length || project.integrations?.length
      || project.connectBuildsEnabled || project.connectConfigurationId != null
      || project.connectConfigurations?.length || project.passiveConnectConfigurationId != null) {
      throw new Error("Vercel 専用 Preview に設定済みの環境変数または外部接続があります。");
    }
  }

  private async deployment(id: string, pr: number): Promise<Deployment | null> {
    const value = await this.api(`/v13/deployments/${id}`, "GET", undefined, true);
    if (value === null) return null;
    const deployment = parse(detailSchema, value);
    if (deployment.id !== id || deployment.projectId !== this.config.projectId
      || deployment.ownerId !== this.config.teamId || deployment.name !== projectName
      || deployment.customEnvironment != null || deployment.meta.millePreviewPr !== String(pr)) {
      throw new Error("Vercel Deployment の所有を確認できません。");
    }
    if (deployment.deletedAt != null || deployment.softDeletedByRetention === true) return null;
    return deployment;
  }

  private async deployments(pr: number): Promise<Deployment[]> {
    const deployments: Deployment[] = [];
    const seen = new Set<string>();
    let until: number | null = null;
    for (let page = 0; page < 100; page++) {
      const suffix: string = until === null ? "" : `&until=${until}`;
      const result = parse(inventory, await this.api(
        `/v6/deployments?projectId=${this.config.projectId}&limit=100${suffix}`,
      ));
      if (result.pagination.count !== result.deployments.length || result.deployments.length > 100) {
        throw new Error("Vercel Deployment の一覧が不完全です。");
      }
      for (const item of result.deployments) {
        if (item.projectId !== this.config.projectId || seen.has(item.uid)) {
          throw new Error("Vercel Deployment の一覧が一致しません。");
        }
        seen.add(item.uid);
        if (item.meta?.millePreviewPr !== String(pr)) continue;
        const deployment = await this.deployment(item.uid, pr);
        if (deployment) deployments.push(deployment);
      }
      const next: number | null = result.pagination.next;
      if (next === null) return deployments.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      if (until !== null && next >= until) break;
      until = next;
    }
    throw new Error("Vercel Deployment の一覧を最後まで確認できません。");
  }

  private async ready(id: string, target: { number: number; sha: string }, hostHash: string, verify: VerifyCurrent) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await verify();
      const current = await this.deployment(id, target.number);
      if (!current || current.meta.millePreviewSha !== target.sha || current.meta.millePreviewDbHostHash !== hostHash) {
        throw new Error("Preview Deployment の HEAD または DB が一致しません。");
      }
      if (current.readyState === "READY") {
        await verify();
        return `https://${current.url}`;
      }
      if (terminal(current.readyState)) throw new Error(`Vercel Preview のビルドが ${current.readyState} で終了しました。`);
      await this.wait(5_000);
    }
    throw new Error("Vercel Preview の READY を確認できませんでした。");
  }

  async deploy(
    target: { number: number; sha: string },
    db: PreviewDatabase,
    files: readonly PreviewSourceFile[],
    verifyCurrent: VerifyCurrent = noOp,
  ): Promise<string> {
    const environmentId = previewDatabaseEnvironmentId(target.number);
    if (!sha.safeParse(target.sha).success) throw new Error("Vercel Preview の HEAD が無効です。");
    let connection: URL;
    try { connection = new URL(db.connectionString); }
    catch { throw new Error("Vercel Preview の DB 接続設定が無効です。"); }
    if (connection.hostname !== db.expectedHost || !/^[a-z0-9.-]+\.neon\.tech$/.test(db.expectedHost)
      || !["postgres:", "postgresql:"].includes(connection.protocol)
      || !connection.username || !connection.password || connection.searchParams.get("sslmode") !== "require") {
      throw new Error("Vercel Preview の DB 接続設定が一致しません。");
    }
    validateSource(files);
    await this.preflight();
    await verifyCurrent();
    const hostHash = createHash("sha256").update(db.expectedHost).digest("hex");
    const deployments = await this.deployments(target.number);
    const active = deployments.find((deployment) =>
      deployment.meta.millePreviewSha === target.sha && deployment.meta.millePreviewDbHostHash === hostHash
      && (deployment.readyState === "READY" || !terminal(deployment.readyState)));
    if (active) return this.ready(active.id, target, hostHash, verifyCurrent);

    // The Vercel CLI omits target for Preview and sends request-local runtime
    // and build overrides as env and build.env. The dedicated project has no inherited variables.
    await verifyCurrent();
    const { id } = parse(z.object({ id: deploymentId, target: previewTarget }), await this.api("/v13/deployments", "POST", {
      name: projectName,
      project: this.config.projectId,
      version: 2,
      autoAssignCustomDomains: false,
      env: {
        AUTH_MODE: "test",
        AUTH_SECRET: randomBytes(32).toString("base64url"),
        MILLE_PREVIEW_DATABASE_URL: db.connectionString,
        MILLE_PREVIEW_DATABASE_HOST: db.expectedHost,
        MILLE_PREVIEW_ENVIRONMENT_ID: environmentId,
        MILLE_SOURCE_SHA: target.sha,
      },
      build: { env: { MILLE_SOURCE_SHA: target.sha } },
      files: files.map(({ file, data }) => ({ file, data: data.toString("base64"), encoding: "base64" })),
      meta: {
        millePreviewProtocol: protocol,
        millePreviewRepository: repository,
        millePreviewPr: String(target.number),
        millePreviewSha: target.sha,
        millePreviewDbHostHash: hostHash,
      },
    }));
    return this.ready(id, target, hostHash, verifyCurrent);
  }

  async remove(pr: number, verifyCurrent: VerifyCurrent = noOp): Promise<void> {
    previewDatabaseEnvironmentId(pr);
    await this.project();
    await verifyCurrent();
    for (const deployment of await this.deployments(pr)) {
      const current = await this.deployment(deployment.id, pr);
      if (!current) continue;
      if (current.meta.millePreviewSha !== deployment.meta.millePreviewSha
        || current.meta.millePreviewDbHostHash !== deployment.meta.millePreviewDbHostHash) {
        throw new Error("削除対象の Vercel Deployment が変わりました。");
      }
      await verifyCurrent();
      await this.api(`/v13/deployments/${current.id}`, "DELETE", undefined, true);
      if (await this.deployment(current.id, pr)) throw new Error("Vercel Deployment の削除を確認できません。");
    }
    if ((await this.deployments(pr)).length) throw new Error("対象 PR の Vercel Deployment が残っています。");
    await verifyCurrent();
  }
}
