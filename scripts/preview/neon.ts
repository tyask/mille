import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { preparePreviewDatabase, previewDatabaseEnvironmentId } from "./database";

const api = "https://console.neon.tech/api/v2";
const projectName = "mille-pr-preview";
const templateName = "mille-pr-template";
const repository = "tyask/mille";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const branchId = identifier.refine(id => id.startsWith("br-"));
const postgresName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const configSchema = z.object({
  apiKey: z.string().min(1),
  projectId: identifier,
  parentBranchId: branchId,
  database: postgresName,
  role: postgresName,
  maxPrBranches: z.number().int().positive(),
});
const branch = z.object({
  id: branchId,
  project_id: identifier,
  parent_id: branchId.nullish(),
  name: z.string(),
  default: z.boolean(),
  primary: z.boolean().nullish(),
  protected: z.boolean(),
  init_source: z.string().nullish(),
  current_state: z.string(),
  pending_state: z.string().nullish(),
});
const branchDetails = z.object({
  branch,
  annotation: z.object({
    object: z.object({ id: z.string() }),
    value: z.record(z.string(), z.string()),
  }).nullish(),
});
const operation = z.object({
  id: identifier,
  branch_id: branchId,
  project_id: identifier,
  status: z.string(),
});
const operations = z.object({ operations: z.array(operation) });
const branchChange = operations.extend({ branch });
const database = z.object({ name: z.string(), branch_id: branchId, owner_name: z.string() });
const role = z.object({ name: z.string(), branch_id: branchId, protected: z.boolean().nullish() });
const endpoint = z.object({
  id: identifier.refine(id => id.startsWith("ep-")),
  host: z.string(),
  project_id: identifier,
  branch_id: branchId,
  type: z.string(),
  disabled: z.boolean(),
});

type Config = z.input<typeof configSchema>;
type Branch = z.infer<typeof branch>;
type VerifyCurrent = () => Promise<void>;

class NeonRequestError extends Error {
  constructor(readonly status: number) {
    super(status ? `Neon API が HTTP ${status} を返しました。` : "Neon API に接続できませんでした。");
  }
}

export class NeonPreview {
  readonly #config: Config;
  readonly #project: string;

  constructor(config: Config) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new Error("Neon PR Preview の設定が無効です。");
    this.#config = parsed.data;
    this.#project = `/projects/${parsed.data.projectId}`;
  }

  async #request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: object): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(`${api}${this.#project}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.#config.apiKey}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (method !== "GET") throw new NeonRequestError(0);
      }
      if (response?.ok) {
        // Provider response bodies may contain passwords. Never show parse errors or the raw body.
        const result = schema.safeParse(await response.json().catch(() => null));
        if (!result.success) throw new Error("Neon API の応答形式が一致しません。");
        return result.data;
      }
      const status = response?.status ?? 0;
      // Neon explicitly permits retrying any request on HTTP 423 or 503.
      const retryable = status === 423 || status === 503 || (method === "GET" && (!status || status === 429 || status >= 500));
      if (!retryable || attempt === 3) throw new NeonRequestError(status);
      await delay(800 * (attempt + 1));
    }
    throw new Error("Neon API の再試行回数を超えました。");
  }

  async #branches(): Promise<Branch[]> {
    const branches: Branch[] = [];
    const seen = new Set<string>();
    const list = z.object({
      branches: z.array(branch),
      pagination: z.object({ next: z.string().nullish() }).nullish(),
    });
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result = await this.#request(`/branches?${params}`, list);
      for (const item of result.branches) {
        if (item.project_id !== this.#config.projectId || seen.has(item.id)) {
          throw new Error("Neon ブランチ一覧を照合できません。");
        }
        seen.add(item.id);
        branches.push(item);
      }
      if (!result.pagination?.next) return branches;
      cursor = result.pagination.next;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new Error("Neon ブランチ一覧を最後まで取得できません。");
  }

  async #postgresResources(id: string) {
    const [roles, databases] = await Promise.all([
      this.#request(`/branches/${id}/roles`, z.object({ roles: z.array(role) })),
      this.#request(`/branches/${id}/databases`, z.object({ databases: z.array(database) })),
    ]);
    if ([...roles.roles, ...databases.databases].some(item => item.branch_id !== id)) {
      throw new Error("Neon DB とロールの所属ブランチが一致しません。");
    }
    return { roles: roles.roles, databases: databases.databases };
  }

  async preflight(): Promise<void> {
    const { projectId, parentBranchId, database, role } = this.#config;
    const [project, parent, resources] = await Promise.all([
      this.#request("", z.object({ project: z.object({ id: identifier, name: z.string() }) })),
      this.#request(`/branches/${parentBranchId}`, branchDetails),
      this.#postgresResources(parentBranchId),
    ]);
    if (project.project.id !== projectId || project.project.name !== projectName
      || parent.branch.id !== parentBranchId || parent.branch.project_id !== projectId
      || parent.branch.name !== templateName || parent.branch.current_state !== "ready" || parent.branch.pending_state
      || resources.databases.some(item => item.name === database) || resources.roles.some(item => item.name === role)) {
      throw new Error("Neon の PR 専用プロジェクトまたはテンプレートが一致しません。");
    }
  }

  #annotation(pr: number): Record<string, string> {
    return { mille_repository: repository, mille_pr: String(pr), mille_database: this.#config.database, mille_role: this.#config.role };
  }

  #assertBranch(branch: Branch, name: string) {
    if (branch.project_id !== this.#config.projectId || branch.parent_id !== this.#config.parentBranchId
      || branch.id === this.#config.parentBranchId || branch.name !== name
      || branch.default || branch.primary || branch.protected || branch.init_source !== "parent-data") {
      throw new Error("Neon PR 専用ブランチの所属が一致しません。");
    }
  }

  async #ownedBranch(id: string, name: string, pr: number): Promise<Branch> {
    const record = await this.#request(`/branches/${id}`, branchDetails);
    this.#assertBranch(record.branch, name);
    const expected = this.#annotation(pr);
    if (record.branch.id !== id || record.annotation?.object.id !== id
      || Object.entries(expected).some(([key, value]) => record.annotation?.value[key] !== value)) {
      throw new Error("Neon PR 専用ブランチの所有情報が一致しません。");
    }
    return record.branch;
  }

  async #waitOperations(result: z.infer<typeof operations>, id: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    const operationResponse = z.object({ operation });
    for (const requested of result.operations) {
      let current = requested;
      for (;;) {
        if (current.id !== requested.id || current.branch_id !== id || current.project_id !== this.#config.projectId) {
          throw new Error("Neon 操作の対象が一致しません。");
        }
        if (current.status === "finished") break;
        if (!["scheduling", "running", "cancelling"].includes(current.status) || Date.now() >= deadline) {
          throw new Error("Neon 操作の完了を確認できません。");
        }
        await delay(1500);
        ({ operation: current } = await this.#request(`/operations/${requested.id}`, operationResponse));
      }
    }
  }

  async #readyBranch(id: string, name: string, pr: number): Promise<Branch> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.#ownedBranch(id, name, pr);
      if (current.current_state === "ready" && !current.pending_state) return current;
      if (current.pending_state === "storage_deleted") break;
      await delay(1500);
    }
    throw new Error("Neon PR 専用ブランチの準備完了を確認できません。");
  }

  async #connection(id: string) {
    const { projectId, database, role } = this.#config;
    const { endpoints } = await this.#request(`/branches/${id}/endpoints`, z.object({ endpoints: z.array(endpoint) }));
    const writable = endpoints.filter(item => item.type === "read_write");
    if (endpoints.some(item => item.branch_id !== id || item.project_id !== projectId)
      || writable.length !== 1 || writable[0].disabled) {
      throw new Error("Neon の専用 read-write エンドポイントを照合できません。");
    }
    const { id: endpointId, host } = writable[0];
    if (!host.endsWith(".neon.tech") || host.split(".")[0] !== endpointId) {
      throw new Error("Neon エンドポイントのホストが一致しません。");
    }
    const params = new URLSearchParams({ branch_id: id, endpoint_id: endpointId, database_name: database, role_name: role, pooled: "false" });
    const { uri } = await this.#request(`/connection_uri?${params}`, z.object({ uri: z.string() }));
    let parsed: URL;
    try { parsed = new URL(uri); } catch { throw new Error("Neon 接続情報が無効です。"); }
    if (parsed.protocol !== "postgresql:" || parsed.host !== host || parsed.pathname !== `/${database}`
      || parsed.username !== role || !parsed.password || parsed.hash
      || parsed.searchParams.getAll("sslmode").join() !== "require") {
      throw new Error("Neon 接続情報が専用の接続先と一致しません。");
    }
    return { connectionString: uri, expectedHost: host, expectedDatabase: database };
  }

  async ensure(pr: number, verifyCurrent?: VerifyCurrent) {
    const name = previewDatabaseEnvironmentId(pr);
    await this.preflight();
    const inventory = await this.#branches();
    const matches = inventory.filter(item => item.name === name);
    if (matches.length > 1) throw new Error("Neon PR 専用ブランチを一意に特定できません。");

    let id = matches[0]?.id;
    if (!id) {
      if (inventory.filter(item => /^mille-pr-[1-9][0-9]*$/.test(item.name)).length >= this.#config.maxPrBranches) {
        throw new Error("Neon PR 専用ブランチの利用枠に空きがありません。");
      }
      await verifyCurrent?.();
      const created = await this.#request("/branches", branchChange, "POST", {
        branch: { name, parent_id: this.#config.parentBranchId, init_source: "parent-data" },
        endpoints: [{ type: "read_write", autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 }],
        annotation_value: this.#annotation(pr),
      });
      this.#assertBranch(created.branch, name);
      id = created.branch.id;
      await this.#waitOperations(created, id);
    }
    await this.#readyBranch(id, name, pr);
    const expectedRole = this.#config.role;
    const expectedDatabase = this.#config.database;
    const resources = await this.#postgresResources(id);
    const roles = resources.roles.filter(item => item.name === expectedRole);
    const databases = resources.databases.filter(item => item.name === expectedDatabase);
    if (roles.length > 1 || roles[0]?.protected || databases.length > 1
      || (databases[0] && (databases[0].owner_name !== expectedRole || !roles[0]))) {
      throw new Error("Neon の専用 DB またはロールを照合できません。");
    }
    if (!roles[0]) {
      await verifyCurrent?.();
      const result = await this.#request(`/branches/${id}/roles`, operations.extend({ role }), "POST", {
        role: { name: expectedRole },
      });
      if (result.role.name !== expectedRole || result.role.branch_id !== id || result.role.protected) {
        throw new Error("作成した Neon ロールを照合できません。");
      }
      await this.#waitOperations(result, id);
    }
    if (!databases[0]) {
      await verifyCurrent?.();
      const result = await this.#request(`/branches/${id}/databases`, operations.extend({ database }), "POST", {
        database: { name: expectedDatabase, owner_name: expectedRole },
      });
      if (result.database.name !== expectedDatabase || result.database.branch_id !== id || result.database.owner_name !== expectedRole) {
        throw new Error("作成した Neon DB を照合できません。");
      }
      await this.#waitOperations(result, id);
    }
    const connection = await this.#connection(id);
    await verifyCurrent?.();
    try {
      // The provider annotation proves ownership across runs. The existing SQL initializes
      // only an empty DB and otherwise requires the exact Mille PR marker and migration history.
      await preparePreviewDatabase({ pr, ...connection, initialize: true });
    } catch {
      throw new Error("Neon PR 専用 DB の環境識別・migration・seed を確認できません。");
    }
    return connection;
  }

  async remove(pr: number, verifyCurrent?: VerifyCurrent): Promise<void> {
    const name = previewDatabaseEnvironmentId(pr);
    await this.preflight();
    const inventory = await this.#branches();
    const matches = inventory.filter(item => item.name === name);
    if (!matches.length) return;
    if (matches.length !== 1) throw new Error("Neon PR 専用ブランチを一意に特定できません。");
    const { id } = await this.#ownedBranch(matches[0].id, name, pr);
    if (inventory.some(item => item.parent_id === id)) throw new Error("Neon PR 専用ブランチに子が存在します。");
    await verifyCurrent?.();
    const removed = await this.#request(`/branches/${id}`, branchChange, "DELETE");
    this.#assertBranch(removed.branch, name);
    if (removed.branch.id !== id) throw new Error("削除した Neon ブランチを照合できません。");
    await this.#waitOperations(removed, id);

    const remaining = await this.#branches();
    if (remaining.some(item => item.id === id || item.name === name)) {
      throw new Error("Neon PR 専用ブランチが一覧に残っています。");
    }
    try {
      await this.#request(`/branches/${id}`, branchDetails);
    } catch (error) {
      if (error instanceof NeonRequestError && error.status === 404) return;
      throw error;
    }
    throw new Error("Neon PR 専用ブランチを直接取得できる状態です。");
  }
}
