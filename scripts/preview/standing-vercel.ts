import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { DatabaseConfiguration } from "../../lib/server/database/environment";
import { milleRepositoryId } from "./native-identity";
import { assertPreviewVercelSource, type PreviewSourceFile, VercelPreview } from "./vercel";

export const standingPreviewAlias = "mille-main-preview-fumin1.vercel.app";
export const standingProductionAliases = ["mille-hazel.vercel.app", "mille-fumin1.vercel.app", "mille-git-main-fumin1.vercel.app"] as const;
export const standingLegacyPreview = { deploymentId: "dpl_PzqN4fUewyF6MtViekWrhWSb5juw",
  origin: "https://mille-hypzm5ss8-fumin1.vercel.app", sha: "7d8001aed54f1a1cec97f7071fbb31b4c9d99c2b" } as const;
const legacyHostname = new URL(standingLegacyPreview.origin).hostname;
const standingEndpoint = "ep-bitter-wind-a1atj6vn";
const standingHost = `${standingEndpoint}.ap-southeast-1.aws.neon.tech`;
const standingHostHash = createHash("sha256").update(standingHost).digest("hex");
const projectName = "mille";
const repository = "tyask/mille";
const protocol = "mille-standing-preview/v1";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const teamId = z.string().regex(/^team_[A-Za-z0-9]+$/);
const repoId = z.union([z.literal(milleRepositoryId), z.literal(String(milleRepositoryId))]);
const configSchema = z.object({ token: z.string().min(1), teamId, projectId });
const projectSchema = z.object({
  id: projectId, accountId: teamId, name: z.literal(projectName),
  link: z.object({ type: z.literal("github"), repoId, productionBranch: z.literal("main") }),
  targets: z.object({ production: z.object({ id: deploymentId }) }),
});
const marker = z.object({
  milleStandingPreviewProtocol: z.literal(protocol), milleStandingPreviewRepository: z.literal(repository),
  milleStandingPreviewSha: shaSchema, milleStandingPreviewEndpointId: z.literal(standingEndpoint),
  milleStandingPreviewDbHostHash: z.literal(standingHostHash),
});
const detail = z.object({
  id: deploymentId, ownerId: teamId, projectId, name: z.literal(projectName),
  url: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/),
  customEnvironment: z.unknown().nullish(), public: z.boolean(), target: z.enum(["preview", "production"]).nullish(),
  deletedAt: z.int().positive().nullish(), softDeletedByRetention: z.boolean().optional(),
  readyState: z.enum(["QUEUED", "INITIALIZING", "ANALYZING", "BUILDING", "DEPLOYING", "READY", "ERROR", "CANCELED", "BLOCKED"]),
  gitSource: z.unknown().nullish(), meta: z.unknown().nullish(),
});
const mainGitSource = z.object({ type: z.literal("github"), repoId, ref: z.literal("main"), sha: shaSchema });
const inventory = z.object({
  deployments: z.array(z.object({
    uid: deploymentId, projectId,
    meta: z.object({ milleStandingPreviewProtocol: z.string().optional(), milleStandingPreviewSha: z.string().optional() }).nullish(),
  })).max(100),
  pagination: z.object({ count: z.int().nonnegative(), next: z.int().positive().nullable() }),
});
const aliasUid = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const binding = z.object({
  uid: aliasUid, alias: z.string(), projectId, deploymentId,
  redirect: z.null().optional(), redirectStatusCode: z.null().optional(),
});
const standingBinding = binding.extend({
  alias: z.literal(standingPreviewAlias), protectionBypass: z.strictObject({}).optional(), microfrontends: z.never().optional(),
});
const assigned = z.object({ uid: aliasUid, alias: z.literal(standingPreviewAlias), oldDeploymentId: deploymentId.nullish() });
const stopped = new Set(["ERROR", "CANCELED", "BLOCKED"]);
const notFound = Symbol("Vercel API 404");

type Config = z.infer<typeof configSchema>;
type VerifyCurrent = () => Promise<void>;
type Method = "GET" | "POST" | "DELETE";
export type StandingPreviewAlias = Pick<z.infer<typeof standingBinding>, "uid" | "alias" | "projectId" | "deploymentId">;
export type StandingPreviewDeployment = { id: string; origin: string; sha: string };
type AliasObservation = Pick<StandingPreviewAlias, "uid" | "deploymentId"> | null | undefined;
type StandingAliasReceipt = {
  alias: typeof standingPreviewAlias;
  deploymentId: string;
  outcome: "acknowledgment-unknown" | "assignment-unverified" | "conflict-restored" | "conflict-unresolved";
  assignedAliasId?: string;
  expectedDeploymentId?: string;
  previousDeploymentId?: string;
  displacedDeploymentId?: string;
  observedAlias?: AliasObservation;
};

export class StandingAliasError extends Error {
  constructor(readonly receipt: StandingAliasReceipt) {
    super("常設 Preview の固定エイリアスの割り当てを完了できません。");
    this.name = "StandingAliasError";
  }
}

export class StandingProductionPending extends Error {
  constructor() { super("最新 main の本番デプロイとエイリアスの反映を待っています。"); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}

function sameAlias(a: StandingPreviewAlias, b: StandingPreviewAlias): boolean {
  return a.uid === b.uid && a.alias === b.alias && a.projectId === b.projectId && a.deploymentId === b.deploymentId;
}

function aliasObservation(value: StandingPreviewAlias | null | undefined): AliasObservation {
  return value ? { uid: value.uid, deploymentId: value.deploymentId } : value;
}

export class StandingPreviewVercel {
  private readonly config: Config;

  constructor(config: Config, private readonly request: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = delay) {
    this.config = parse(configSchema, config, "常設 Preview の Vercel 設定が一致しません。");
  }

  private async api(path: string, method: Method = "GET", body?: unknown, allowMissing = false): Promise<unknown> {
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
    } catch { throw new Error(`Vercel API ${method} の応答を確認できません。`); }
    if (response.status === 404 && allowMissing) return notFound;
    if (!response.ok) throw new Error(`Vercel API ${method} が失敗しました (HTTP ${response.status})。`);
    if (method === "DELETE") return null;
    try { return await response.json() as unknown; }
    catch { throw new Error("Vercel API の応答形式を確認できません。"); }
  }

  private async ownedDeployment(id: string) {
    id = parse(deploymentId, id, "Vercel デプロイ ID が無効です。");
    const item = parse(detail, await this.api(`/v13/deployments/${id}?withGitRepoInfo=true`), "Vercel デプロイの形式を照合できません。");
    if (item.id !== id || item.projectId !== this.config.projectId || item.ownerId !== this.config.teamId
      || item.deletedAt != null || item.softDeletedByRetention === true) {
      throw new Error("Vercel デプロイの所有と存続を照合できません。");
    }
    return item;
  }

  async readBaseline(expectedSha?: string) {
    const project = parse(projectSchema, await this.api(`/v9/projects/${this.config.projectId}`), "Vercel プロジェクトを照合できません。");
    if (project.id !== this.config.projectId || project.accountId !== this.config.teamId) {
      throw new Error("Vercel プロジェクトの所有が一致しません。");
    }
    const productionDeploymentId = project.targets.production.id;
    const [production, previous, ...aliasRecords] = await Promise.all([
      this.ownedDeployment(productionDeploymentId), this.ownedDeployment(standingLegacyPreview.deploymentId),
      ...standingProductionAliases.map(async (name) => ({ name, value: await this.api(`/v4/aliases/${name}`) })),
    ]);
    if (previous.url !== legacyHostname || previous.readyState !== "READY" || previous.target === "production" || previous.public) {
      throw new Error("既存の常設 Preview を照合できません。");
    }
    if (production.target !== "production" || stopped.has(production.readyState)) {
      throw new Error("現用の本番デプロイを照合できません。");
    }
    const { sha: productionSha } = parse(mainGitSource, production.gitSource, "現用の本番デプロイの Git 出典を照合できません。");
    const aliases = aliasRecords.map(({ name, value }) => {
      const alias = parse(binding, value, "現用の本番エイリアスの形式を照合できません。");
      if (alias.alias !== name || alias.projectId !== project.id) {
        throw new Error("現用の本番エイリアスの割り当てを照合できません。");
      }
      return [name, alias.deploymentId] as const;
    });
    const ready = production.readyState === "READY" && aliases.every(([, id]) => id === productionDeploymentId);
    if (expectedSha !== undefined && (!ready || productionSha !== expectedSha)) throw new StandingProductionPending();
    if (production.readyState !== "READY") throw new Error("現用の本番デプロイを照合できません。");
    if (!ready) throw new Error("現用の本番エイリアスの割り当てを照合できません。");
    return { productionDeploymentId, productionSha,
      productionAliases: Object.fromEntries(aliases) as Record<typeof standingProductionAliases[number], string>, legacyDeploymentId: previous.id };
  }

  async readAlias(): Promise<StandingPreviewAlias | null> {
    const response = await this.api(`/v4/aliases/${standingPreviewAlias}`, "GET", undefined, true);
    if (response === notFound) return null;
    const { uid, alias, projectId: owner, deploymentId: deployment } = parse(standingBinding, response, "常設 Preview の固定エイリアスを照合できません。");
    if (owner !== this.config.projectId) throw new Error("固定エイリアスの所有プロジェクトが一致しません。");
    return { uid, alias, projectId: owner, deploymentId: deployment };
  }

  async preflight(): Promise<void> {
    await new VercelPreview(this.config, this.request).preflight();
    const domain = await this.api(`/v9/projects/${this.config.projectId}/domains/${standingPreviewAlias}`, "GET", undefined, true);
    if (domain !== notFound) throw new Error("固定 Preview のホストが Vercel プロジェクトのドメインに登録されています。");
  }

  private async standingDeployment(id: string, expectedSha?: string) {
    const item = await this.ownedDeployment(id);
    const { milleStandingPreviewSha: sha } = parse(marker, item.meta, "常設 Preview のデプロイの所有情報が一致しません。");
    if (item.target === "production" || item.customEnvironment != null || item.public || item.gitSource != null
      || item.url === standingPreviewAlias || item.url === legacyHostname || standingProductionAliases.some(alias => alias === item.url)
      || (expectedSha !== undefined && sha !== expectedSha)) {
      throw new Error("常設 Preview の環境、固有 URL または SHA が一致しません。");
    }
    return { id: item.id, origin: `https://${item.url}`, sha, state: item.readyState };
  }

  async readDeployment(id: string, sha: string | undefined, endpointId: string): Promise<StandingPreviewDeployment> {
    if (sha !== undefined) parse(shaSchema, sha, "常設 Preview の SHA が無効です。");
    if (endpointId !== standingEndpoint) throw new Error("常設 Preview の DB endpoint が一致しません。");
    const item = await this.standingDeployment(id, sha);
    if (item.state !== "READY") throw new Error("常設 Preview の READY を確認できません。");
    return { id: item.id, origin: item.origin, sha: item.sha };
  }

  private async activeDeployment(sha: string) {
    const seen = new Set<string>();
    const candidates: string[] = [];
    let until: number | null = null;
    for (let page = 0; page < 100; page++) {
      const suffix: string = until === null ? "" : `&until=${until}`;
      const list = parse(inventory, await this.api(`/v6/deployments?projectId=${this.config.projectId}&limit=100${suffix}`), "Vercel デプロイ一覧を照合できません。");
      if (list.pagination.count !== list.deployments.length) break;
      for (const item of list.deployments) {
        if (item.projectId !== this.config.projectId || seen.has(item.uid)) throw new Error("Vercel デプロイ一覧が一致しません。");
        seen.add(item.uid);
        if (item.meta?.milleStandingPreviewProtocol !== protocol || item.meta.milleStandingPreviewSha !== sha) continue;
        const current = await this.standingDeployment(item.uid, sha);
        if (!stopped.has(current.state)) candidates.push(current.id);
      }
      const next: number | null = list.pagination.next;
      if (next === null) {
        if (candidates.length > 1) throw new Error("同じ SHA の常設 Preview を一意に特定できません。");
        return candidates[0];
      }
      if (until !== null && next >= until) break;
      until = next;
    }
    throw new Error("Vercel デプロイ一覧を最後まで照合できません。");
  }

  async deploy(input: { sha: string; database: Extract<DatabaseConfiguration, { mode: "hosted" }>; endpointId: string;
    files: readonly PreviewSourceFile[] }, verifyCurrent: VerifyCurrent): Promise<StandingPreviewDeployment> {
    const { database, endpointId, files, sha } = input;
    parse(shaSchema, sha, "常設 Preview の SHA が無効です。");
    let connection: URL;
    try { connection = new URL(database.url); }
    catch { throw new Error("常設 Preview の DB 接続設定が無効です。"); }
    if (endpointId !== standingEndpoint || database.mode !== "hosted" || database.environment !== "preview"
      || database.environmentId !== "mille-preview" || database.host !== standingHost || connection.hostname !== standingHost
      || !["postgres:", "postgresql:"].includes(connection.protocol) || connection.username !== "neondb_owner" || !connection.password
      || connection.pathname !== "/neondb" || connection.port || connection.hash
      || connection.searchParams.get("sslmode") !== "require") {
      throw new Error("常設 Preview の DB 接続先が一致しません。");
    }
    const config = assertPreviewVercelSource(files);
    if (config !== undefined && !z.object({ alias: z.never().optional() }).safeParse(config).success) {
      throw new Error("常設 Preview のデプロイ前にエイリアスを設定できません。");
    }
    await this.preflight();
    let id = await this.activeDeployment(sha);
    await verifyCurrent();
    if (!id) {
      const created = parse(z.object({ id: deploymentId, target: z.literal("preview").nullish() }),
        await this.api("/v13/deployments?forceNew=1", "POST", {
          name: projectName, project: this.config.projectId, version: 2, autoAssignCustomDomains: false,
          env: {
            AUTH_MODE: "test", AUTH_SECRET: randomBytes(32).toString("base64url"),
            MILLE_PREVIEW_DATABASE_URL: database.url, MILLE_PREVIEW_DATABASE_HOST: database.host,
            MILLE_PREVIEW_ENVIRONMENT_ID: database.environmentId, MILLE_SOURCE_SHA: sha,
          },
          build: { env: { MILLE_SOURCE_SHA: sha } },
          files: files.map(({ file, data }) => ({ file, data: data.toString("base64"), encoding: "base64" })),
          meta: {
            milleStandingPreviewProtocol: protocol, milleStandingPreviewRepository: repository, milleStandingPreviewSha: sha,
            milleStandingPreviewEndpointId: endpointId, milleStandingPreviewDbHostHash: standingHostHash,
          },
        }), "常設 Preview のデプロイ作成を確認できません。");
      id = created.id;
    }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await verifyCurrent();
      const current = await this.standingDeployment(id, sha);
      if (current.state === "READY") {
        await verifyCurrent();
        return { id: current.id, origin: current.origin, sha: current.sha };
      }
      if (stopped.has(current.state)) throw new Error(`常設 Preview のビルドが ${current.state} で終了しました。`);
      await this.wait(5_000);
    }
    throw new Error("常設 Preview の READY を確認できません。");
  }

  private async postAlias(id: string) {
    return parse(assigned, await this.api(`/v2/deployments/${id}/aliases`, "POST", { alias: standingPreviewAlias }),
      "固定エイリアスの割り当ての応答を確認できません。");
  }

  private async observeAlias() {
    return this.readAlias().catch(() => undefined);
  }

  private async restoreAliasConflict(created: StandingPreviewAlias, previousDeploymentId: string, expectedDeploymentId?: string): Promise<never> {
    let outcome: StandingAliasReceipt["outcome"] = "conflict-unresolved";
    let observed: StandingPreviewAlias | null | undefined;
    let displacedDeploymentId: string | undefined;
    try {
      await this.preflight();
      const previous = expectedDeploymentId ? await this.standingDeployment(previousDeploymentId) : await this.ownedDeployment(previousDeploymentId);
      const protectedPreview = "state" in previous ? previous.state === "READY"
        : previous.readyState === "READY" && previous.target !== "production" && !previous.public && previous.customEnvironment == null;
      observed = await this.observeAlias();
      if (previous.id !== created.deploymentId && protectedPreview && observed && sameAlias(observed, created)) {
        // Vercel alias writes are unconditional. Re-read immediately before the single compensation attempt.
        const restored = await this.postAlias(previous.id);
        displacedDeploymentId = restored.oldDeploymentId ?? undefined;
        observed = await this.observeAlias();
        if (displacedDeploymentId === created.deploymentId && observed?.uid === restored.uid && observed.deploymentId === previous.id) {
          outcome = "conflict-restored";
        }
      }
    } catch { observed = await this.observeAlias(); }
    throw new StandingAliasError({ alias: standingPreviewAlias, deploymentId: created.deploymentId, assignedAliasId: created.uid,
      ...(expectedDeploymentId && { expectedDeploymentId }),
      previousDeploymentId, displacedDeploymentId, observedAlias: aliasObservation(observed), outcome });
  }

  async assignAlias(deployment: string, verifyCurrent: VerifyCurrent, onAssigned?: (alias: StandingPreviewAlias) => void,
    previous: StandingPreviewAlias | null = null): Promise<StandingPreviewAlias> {
    await this.preflight();
    const item = await this.standingDeployment(deployment);
    if (item.state !== "READY") throw new Error("固定エイリアスを割り当てる READY デプロイを照合できません。");
    if (previous) {
      const current = await this.standingDeployment(previous.deploymentId);
      if (current.state !== "READY" || current.id === item.id) throw new Error("固定エイリアスの更新元を照合できません。");
    }
    await verifyCurrent();
    const before = await this.readAlias();
    if (previous ? !before || !sameAlias(before, previous) : before) {
      throw new Error("固定エイリアスの既存の割り当てが一致しません。");
    }
    const response = await this.postAlias(item.id).catch(() => undefined);
    const attempt = { alias: standingPreviewAlias, deploymentId: item.id } as const;
    if (!response) {
      throw new StandingAliasError({ ...attempt, outcome: "acknowledgment-unknown", observedAlias: aliasObservation(await this.observeAlias()) });
    }
    const created: StandingPreviewAlias = { ...attempt, uid: response.uid, projectId: this.config.projectId };
    const displaced = response.oldDeploymentId ?? undefined;
    if (displaced !== previous?.deploymentId) {
      if (displaced) return this.restoreAliasConflict(created, displaced, previous?.deploymentId);
      throw new StandingAliasError({ ...attempt, outcome: "conflict-unresolved", assignedAliasId: created.uid,
        expectedDeploymentId: previous?.deploymentId, observedAlias: aliasObservation(await this.observeAlias()) });
    }
    onAssigned?.(created);
    const verified = await this.observeAlias();
    if (!verified || !sameAlias(verified, created)) {
      throw new StandingAliasError({ ...attempt, outcome: "assignment-unverified", assignedAliasId: created.uid,
        observedAlias: aliasObservation(verified) });
    }
    return verified;
  }

  async restoreAlias(assignedAlias: StandingPreviewAlias, previous: StandingPreviewAlias, verify: VerifyCurrent): Promise<StandingPreviewAlias> {
    await this.preflight();
    const previousItem = await this.standingDeployment(previous.deploymentId);
    if (previousItem.state !== "READY" || previousItem.id === assignedAlias.deploymentId) {
      throw new Error("復元する常設 Preview を照合できません。");
    }
    await verify();
    const current = await this.readAlias();
    if (!current || !sameAlias(current, assignedAlias)) throw new Error("復元前に固定エイリアスの割り当てが変わりました。");
    const restored = await this.postAlias(previousItem.id).catch(() => undefined);
    const displaced = restored?.oldDeploymentId;
    if (restored && displaced && displaced !== current.deploymentId) {
      const justRestored = { ...current, uid: restored.uid, deploymentId: previousItem.id };
      return this.restoreAliasConflict(justRestored, displaced, current.deploymentId);
    }
    const observed = await this.observeAlias();
    if (restored?.oldDeploymentId !== current.deploymentId || !observed || observed.uid !== restored.uid
      || observed.deploymentId !== previousItem.id) {
      throw new StandingAliasError({ alias: standingPreviewAlias, deploymentId: current.deploymentId, assignedAliasId: current.uid,
        previousDeploymentId: previousItem.id, displacedDeploymentId: restored?.oldDeploymentId ?? undefined,
        outcome: "conflict-unresolved", observedAlias: aliasObservation(observed) });
    }
    return observed;
  }

  async removeAlias(knownAlias: StandingPreviewAlias, verifyCurrent: VerifyCurrent): Promise<void> {
    const expected = parse(standingBinding, knownAlias, "固定エイリアスの取り消し対象が無効です。");
    if (expected.projectId !== this.config.projectId) throw new Error("固定エイリアスの取り消し対象の所有が一致しません。");
    await this.standingDeployment(expected.deploymentId);
    await verifyCurrent();
    const current = await this.readAlias();
    if (!current) return;
    if (!sameAlias(current, expected)) throw new Error("取り消し前に固定エイリアスの割り当てが変わりました。");
    await this.api(`/v2/aliases/${current.uid}`, "DELETE", undefined, true);
    if (await this.readAlias()) throw new Error("固定エイリアスの取り消しを確認できません。");
  }
}
