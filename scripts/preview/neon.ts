import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { neon, neonConfig } from "@neondatabase/serverless";
import { z } from "zod";
import type { MigrationSource } from "../db/sql";
import { preparePreviewDatabase, previewDatabaseEnvironmentId } from "./database";
import { isNativePreviewTaskBranch } from "./native-identity";
import { NativePilotHttpError, NativePilotStageError, nativePilotStage } from "./native-pilot-diagnostics";

const api = "https://console.neon.tech/api/v2";
const projectName = "mille-preview";
const templateName = "mille-pr-template";
const templateDatabase = "neondb";
const templateRole = "neondb_owner";
const repository = "tyask/mille";

const templateSqlHttp = new AsyncLocalStorage<{ status?: number }>();
const observingFetches = new WeakSet<typeof fetch>();

function observeTemplateSqlHttp(): void {
  const configuredFetch = neonConfig.fetchFunction as typeof fetch | undefined;
  if (configuredFetch && observingFetches.has(configuredFetch)) return;
  const observingFetch: typeof fetch = async (...args) => {
    const observation = templateSqlHttp.getStore();
    const response = await (configuredFetch ?? globalThis.fetch)(...args);
    if (observation) observation.status = response.status;
    return response;
  };
  observingFetches.add(observingFetch);
  neonConfig.fetchFunction = observingFetch;
}

// Neon provides cloud_admin-owned monitoring objects in its system databases.
const templateInspection = `
  SELECT pg_catalog.current_database() AS database, current_user AS role,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_database d WHERE NOT (
        (d.datname = 'neondb' AND pg_catalog.pg_get_userbyid(d.datdba) = 'neondb_owner' AND NOT d.datistemplate AND d.datallowconn)
        OR (pg_catalog.pg_get_userbyid(d.datdba) = 'cloud_admin' AND (
          (d.datname = 'postgres' AND NOT d.datistemplate AND d.datallowconn)
          OR (d.datname = 'template1' AND d.datistemplate AND d.datallowconn)
          OR (d.datname = 'template0' AND d.datistemplate AND NOT d.datallowconn)
        ))
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_'
        AND r.rolname NOT IN ('cloud_admin', 'neon_service', 'neon_superuser', 'token_roles', 'neondb_owner')
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname NOT IN ('public', 'information_schema') AND n.nspname !~ '^pg_'
        AND pg_catalog.pg_get_userbyid(n.nspowner) <> 'cloud_admin'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND pg_catalog.pg_get_userbyid(c.relowner) <> 'cloud_admin'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND pg_catalog.pg_get_userbyid(p.proowner) <> 'cloud_admin'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_largeobject_metadata
    ) AS empty
`;
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
const endpointIdentifier = identifier.refine(id => id.startsWith("ep-"));
const operation = z.object({
  id: identifier,
  action: z.string().min(1),
  branch_id: branchId.nullish(),
  endpoint_id: endpointIdentifier.nullish(),
  project_id: identifier,
  status: z.string(),
});
const operations = z.object({ operations: z.array(operation) });
const branchChange = operations.extend({ branch });
const database = z.object({ name: z.string(), branch_id: branchId, owner_name: z.string() });
const role = z.object({ name: z.string(), branch_id: branchId, protected: z.boolean().nullish() });
const endpoint = z.object({
  id: endpointIdentifier,
  host: z.string(),
  project_id: identifier,
  branch_id: branchId,
  type: z.string(),
  disabled: z.boolean(),
});
const branchEndpoints = z.object({ endpoints: z.array(endpoint) });
const nativeBranchDetails = z.object({ branch: branch.extend({ created_at: z.iso.datetime() }) });
const terminalCursor = z.union([z.literal(""), z.null()]).optional();
const completeInventory = z.object({ next: terminalCursor, cursor: terminalCursor }).nullish();
const nativeBranchInventory = z.object({ branches: z.array(branch), pagination: completeInventory });
const nativeEndpointInventory = z.object({ endpoints: z.array(endpoint), pagination: completeInventory });
const nativeIdentity = z.object({ id: branchId, endpointId: endpointIdentifier, host: z.string() });
const connectionUri = z.object({ uri: z.string() });

type Config = z.input<typeof configSchema>;
type Branch = z.infer<typeof branch>;
type VerifyCurrent = () => Promise<void>;
export type NativeNeonBranch = z.infer<typeof nativeIdentity>;
export { branchDetails as neonPreviewBranchDetails, branchEndpoints as neonPreviewBranchEndpoints,
  nativeBranchInventory as neonPreviewBranchInventory, connectionUri as neonPreviewConnectionUri };

export function neonPreviewConnectionQuery(branchId: string, endpointId: string, database: string, role: string) {
  return new URLSearchParams({ branch_id: branchId, endpoint_id: endpointId, database_name: database,
    role_name: role, pooled: "false" });
}

export function matchesNeonPreviewConnection(url: URL, host: string, database: string, role: string): boolean {
  return url.protocol === "postgresql:" && url.host === host && url.pathname === `/${database}`
    && url.username === role && url.password.length > 0 && !url.hash
    && url.searchParams.getAll("sslmode").join() === "require";
}

function nativeBranchName(ref: string, notBefore?: number, notAfter?: number): string {
  if (!isNativePreviewTaskBranch(ref)
    || [notBefore, notAfter].some(time => time !== undefined && (!Number.isSafeInteger(time) || time < 0))
    || (notBefore !== undefined && notAfter !== undefined && notAfter < notBefore)) {
    throw new Error("Neon Native Preview のブランチ照合条件が無効です。");
  }
  return `preview/${ref}`;
}

function isNativeDirectHost(id: string, host: string): boolean {
  return /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(host)
    && host.split(".")[0] === id && !id.endsWith("-pooler");
}

function sameNativeBranch(left: NativeNeonBranch, right: NativeNeonBranch): boolean {
  return left.id === right.id && left.endpointId === right.endpointId && left.host === right.host;
}

function nativePassword(connection: string): string {
  try {
    const password = decodeURIComponent(new URL(connection).password);
    if (password && !/[\u0000-\u001f\u007f]/.test(password)) return password;
  } catch {
    // Do not expose connection strings or decoder errors.
  }
  throw new Error("Neon Native Preview のロール資格情報を照合できません。");
}

export class NeonPreviewError extends Error {
  constructor(message: string, readonly diagnostic: string, readonly httpStatus?: number) {
    super(message);
  }
}

class NeonRequestError extends NeonPreviewError {
  constructor(readonly status: number, request: string) {
    super(
      status ? `Neon API が HTTP ${status} を返しました。` : "Neon API に接続できませんでした。",
      `${request}.${status ? `http_${status}` : "network"}`,
      status || undefined,
    );
  }
}

function requestCategory(path: string): string {
  const [, resource, id, child] = path.split("?")[0].split("/");
  switch (resource) {
    case "branches":
      if (child === "roles" || child === "databases" || child === "endpoints") return child;
      return id ? "branch" : "branches";
    case "connection_uri": return "connection_uri";
    case "operations": return "operation";
    default: return "project";
  }
}

const diagnosticSchemaProperties = new Set([
  "project", "branch", "branches", "annotation", "object", "value", "roles", "databases",
  "endpoints", "operation", "operations", "uri", "pagination", "id", "project_id", "branch_id",
  "parent_id", "endpoint_id", "name", "default", "primary", "protected", "init_source",
  "current_state", "pending_state", "owner_name", "role", "database", "host", "type",
  "disabled", "action", "status", "next",
]);

export class NeonPreview {
  readonly #config: Config;
  readonly #project: string;

  constructor(config: Config) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new Error("Neon PR Preview の設定が無効です。");
    this.#config = parsed.data;
    this.#project = `/projects/${parsed.data.projectId}`;
  }

  async #request<T>(
    path: string, schema: z.ZodType<T>, method = "GET", body?: object, verifyCurrent?: VerifyCurrent,
  ): Promise<T> {
    const request = `${method}.${requestCategory(path)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      await verifyCurrent?.();
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
        if (method !== "GET") throw new NeonRequestError(0, request);
      }
      if (response?.ok) {
        // Provider response bodies may contain passwords. Never show parse errors or the raw body.
        const result = schema.safeParse(await response.json().catch(() => null));
        if (!result.success) {
          const path = result.error.issues[0]?.path ?? [];
          // Annotation map entries can have arbitrary provider-defined names.
          const schemaPath = path[0] === "annotation" && path[1] === "value" ? path.slice(0, 2) : path;
          const field = schemaPath
            .filter((key): key is string => typeof key === "string" && diagnosticSchemaProperties.has(key))
            .join(".") || "response";
          throw new NeonPreviewError("Neon API の応答形式が一致しません。", `${request}.schema.${field}`, response.status);
        }
        return result.data;
      }
      const status = response?.status ?? 0;
      // Neon explicitly permits retrying any request on HTTP 423 or 503.
      const retryable = status === 423 || status === 503 || (method === "GET" && (!status || status === 429 || status >= 500));
      if (!retryable || attempt === 3) throw new NeonRequestError(status, request);
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
    const { projectId, parentBranchId } = this.#config;
    const [project, parent] = await Promise.all([
      this.#request("", z.object({ project: z.object({ id: identifier, name: z.string() }) })),
      this.#request(`/branches/${parentBranchId}`, branchDetails),
    ]);
    if (project.project.id !== projectId || project.project.name !== projectName
      || parent.branch.id !== parentBranchId || parent.branch.project_id !== projectId
      || parent.branch.name !== templateName || parent.branch.default || parent.branch.primary || parent.branch.parent_id) {
      throw new Error("Neon の PR 専用プロジェクトまたはテンプレートが一致しません。");
    }
  }

  async #assertEmptyTemplate(nativeRoot?: NativeNeonBranch): Promise<void> {
    if (!nativeRoot) {
      const { connectionString } = await this.#templateConnection();
      await this.#inspectTemplateDatabases(connectionString);
      return;
    }
    const { connectionString } = await nativePilotStage("neon-template-metadata", () => this.#templateConnection(nativeRoot));
    await nativePilotStage("neon-template-sql", () => this.#inspectTemplateDatabases(connectionString, true));
  }

  async #templateConnection(nativeRoot?: NativeNeonBranch) {
    const { parentBranchId } = this.#config;
    const [parent, resources] = await Promise.all([
      this.#request(`/branches/${parentBranchId}`, branchDetails),
      this.#postgresResources(parentBranchId),
    ]);
    if (parent.branch.id !== parentBranchId || parent.branch.project_id !== this.#config.projectId
      || parent.branch.name !== templateName || parent.branch.current_state !== "ready" || parent.branch.pending_state
      || (nativeRoot && (!parent.branch.default || parent.branch.parent_id != null))) {
      throw new Error("Neon テンプレートの準備完了を確認できません。");
    }
    if (resources.databases.length !== 1 || resources.databases[0].name !== templateDatabase
      || resources.databases[0].owner_name !== templateRole || resources.roles.length !== 1
      || resources.roles[0].name !== templateRole || resources.roles[0].protected) {
      throw new Error("Neon テンプレートの DB またはロールの一覧が一致しません。");
    }
    return this.#connection(parentBranchId, templateDatabase, templateRole, nativeRoot);
  }

  async #inspectTemplateDatabases(connectionString: string, captureHttpStatus = false): Promise<void> {
    if (captureHttpStatus) observeTemplateSqlHttp();
    for (const name of [templateDatabase, "postgres", "template1"]) {
      const url = new URL(connectionString);
      url.pathname = `/${name}`;
      // The SDK's error does not expose a status. Observe each response without reading its body.
      const observation: { status?: number } | undefined = captureHttpStatus ? {} : undefined;
      const read = async () => {
        const query = neon(url.href);
        const [rows] = await query.transaction([query.query(templateInspection)], { readOnly: true });
        if (rows.length !== 1 || rows[0].database !== name || rows[0].role !== templateRole || rows[0].empty !== true) {
          throw new Error("Neon テンプレートの内容が一致しません。");
        }
      };
      try {
        await (observation ? templateSqlHttp.run(observation, read) : read());
      } catch {
        const message = "Neon テンプレートが空であることを確認できません。";
        if (observation?.status !== undefined) throw new NativePilotHttpError(message, observation.status);
        throw new Error(message);
      }
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
    const message = "Neon PR 専用ブランチの所有情報が一致しません。";
    if (record.branch.id !== id) throw new NeonPreviewError(message, "GET.branch.identity_mismatch");
    if (!record.annotation) throw new NeonPreviewError(message, "GET.branch.annotation_missing");
    if (record.annotation.object.id !== id) throw new NeonPreviewError(message, "GET.branch.annotation_identity_mismatch");
    for (const [key, value] of Object.entries(expected)) {
      if (record.annotation.value[key] !== value) {
        throw new NeonPreviewError(message, `GET.branch.annotation_mismatch.${key}`);
      }
    }
    return record.branch;
  }

  async #waitOperations(result: z.infer<typeof operations>, id: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    const operationResponse = z.object({ operation });
    for (const requested of result.operations) {
      let current = requested;
      for (;;) {
        // Neon synchronizes project endpoint configuration as part of branch creation.
        const validScope = current.branch_id === id
          || (current.action === "epc_sync" && !current.branch_id && !current.endpoint_id);
        if (!validScope || current.id !== requested.id || current.action !== requested.action
          || current.project_id !== this.#config.projectId
          || (current.branch_id ?? null) !== (requested.branch_id ?? null)
          || (current.endpoint_id ?? null) !== (requested.endpoint_id ?? null)) {
          throw new NeonPreviewError("Neon 操作の対象が一致しません。", "operation.target_mismatch");
        }
        if (current.status === "finished" || current.status === "skipped") break;
        if (!["scheduling", "running", "cancelling"].includes(current.status) || Date.now() >= deadline) {
          throw new NeonPreviewError("Neon 操作の完了を確認できません。", "operation.incomplete");
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

  async #writableEndpoint(id: string) {
    const { projectId } = this.#config;
    const { endpoints } = await this.#request(`/branches/${id}/endpoints`, branchEndpoints);
    const writable = endpoints.filter(item => item.type === "read_write");
    if (endpoints.some(item => item.branch_id !== id || item.project_id !== projectId)
      || writable.length !== 1 || writable[0].disabled) {
      throw new Error("Neon の専用 read-write エンドポイントを照合できません。");
    }
    const { id: endpointId, host } = writable[0];
    if (!host.endsWith(".neon.tech") || host.split(".")[0] !== endpointId) {
      throw new Error("Neon エンドポイントのホストが一致しません。");
    }
    return writable[0];
  }

  async #connection(id: string, database: string, role: string, expected?: NativeNeonBranch) {
    const { id: endpointId, host } = await this.#writableEndpoint(id);
    if (expected && !sameNativeBranch(expected, { id, endpointId, host })) {
      throw new Error("Neon Native Preview の接続先が変わりました。");
    }
    const params = neonPreviewConnectionQuery(id, endpointId, database, role);
    const { uri } = await this.#request(`/connection_uri?${params}`, connectionUri);
    let parsed: URL;
    try { parsed = new URL(uri); } catch { throw new Error("Neon 接続情報が無効です。"); }
    if (!matchesNeonPreviewConnection(parsed, host, database, role)) {
      throw new Error("Neon 接続情報が専用の接続先と一致しません。");
    }
    return { connectionString: uri, expectedHost: host, expectedDatabase: database };
  }

  async #nativeRoot(id: string, name: string, isDefault: boolean): Promise<NativeNeonBranch> {
    if (!branchId.safeParse(id).success) throw new Error("Neon Native Preview の分岐元設定が無効です。");
    const { branch: root } = await this.#request(`/branches/${id}`, branchDetails);
    if (root.id !== id || root.project_id !== this.#config.projectId || root.name !== name
      || root.default !== isDefault || root.parent_id != null || root.current_state !== "ready" || root.pending_state != null) {
      throw new Error("Neon Native Preview の分岐元と常設 root を照合できません。");
    }
    return this.#nativeEndpoint(id);
  }

  async #nativeEndpoint(id: string): Promise<NativeNeonBranch> {
    const { id: endpointId, host } = await this.#writableEndpoint(id);
    if (!isNativeDirectHost(endpointId, host)) throw new Error("Neon Native Preview の直接接続先を照合できません。");
    return { id, endpointId, host };
  }

  async nativePreflight(standingBranchId: string, expectedStandingEndpointId: string, pilotRefs: readonly string[] = []): Promise<void> {
    const { projectId, parentBranchId } = this.#config;
    if (standingBranchId === parentBranchId || !branchId.safeParse(standingBranchId).success
      || !endpointIdentifier.safeParse(expectedStandingEndpointId).success) {
      throw new Error("Neon Native Preview の分岐元設定が無効です。");
    }
    const { project } = await this.#request("", z.object({ project: z.object({ id: identifier, name: z.string() }) }));
    if (project.id !== projectId || project.name !== projectName) throw new Error("Neon Native Preview のプロジェクトが一致しません。");
    const [template, standing] = await Promise.all([
      this.#nativeRoot(parentBranchId, templateName, true), this.#nativeRoot(standingBranchId, "main", false),
    ]);
    if (standing.endpointId !== expectedStandingEndpointId || template.endpointId === standing.endpointId) {
      throw new Error("Neon Native Preview の常設接続先が一致しません。");
    }
    const names = new Set(pilotRefs.map(ref => nativeBranchName(ref)));
    const [inventory, endpoints] = await Promise.all([this.#nativeBranches(), this.#nativeEndpoints()]);
    if (!inventory.some(item => item.id === template.id) || !inventory.some(item => item.id === standing.id)) {
      throw new Error("Neon Native Preview の分岐元と常設ブランチを一覧で確認できません。");
    }
    if (endpoints.some(item => !inventory.some(branch => branch.id === item.branch_id))) {
      throw new Error("Neon Native Preview の接続先の所属を一覧で確認できません。");
    }
    for (const child of inventory.filter(item => item.id !== template.id && item.id !== standing.id)) {
      if (!names.has(child.name)) throw new Error("Neon Native Preview の試験対象以外のブランチが存在します。");
      this.#assertNativeChild(child, child.name);
    }
    await this.#assertEmptyTemplate(template);
  }

  async #nativeBranches(): Promise<Branch[]> {
    const { branches } = await this.#request("/branches?limit=100", nativeBranchInventory);
    if (new Set(branches.map(item => item.id)).size !== branches.length
      || branches.some(item => item.project_id !== this.#config.projectId)) {
      throw new Error("Neon Native Preview のブランチ一覧を照合できません。");
    }
    return branches;
  }

  async #nativeEndpoints() {
    const { endpoints } = await this.#request("/endpoints", nativeEndpointInventory);
    if (new Set(endpoints.map(item => item.id)).size !== endpoints.length
      || endpoints.some(item => item.project_id !== this.#config.projectId)) {
      throw new Error("Neon Native Preview の接続先一覧を照合できません。");
    }
    return endpoints;
  }

  #assertNativeChild(item: Branch, name: string): void {
    if (item.project_id !== this.#config.projectId || item.parent_id !== this.#config.parentBranchId
      || item.id === this.#config.parentBranchId || item.name !== name || item.default || item.primary || item.protected) {
      throw new Error("Neon Native Preview の子ブランチの所属が一致しません。");
    }
  }

  async #verifiedNativeBranch(
    branches: readonly Branch[], name: string, notBefore?: number, notAfter?: number,
  ): Promise<NativeNeonBranch | null> {
    const matches = branches.filter(item => item.name === name);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("Neon Native Preview の子ブランチが一意ではありません。");
    const [listed] = matches;
    this.#assertNativeChild(listed, name);
    const { branch: current } = await this.#request(`/branches/${listed.id}`, nativeBranchDetails);
    this.#assertNativeChild(current, name);
    const createdAt = Date.parse(current.created_at);
    if (current.id !== listed.id || current.current_state !== "ready" || current.pending_state != null
      || (notBefore !== undefined && createdAt < notBefore) || (notAfter !== undefined && createdAt > notAfter)) {
      throw new Error("Neon Native Preview の子ブランチの状態または作成時刻が一致しません。");
    }
    return this.#nativeEndpoint(current.id);
  }

  async findNativeBranch(ref: string, notBefore?: number, notAfter?: number): Promise<NativeNeonBranch | null> {
    const name = nativeBranchName(ref, notBefore, notAfter);
    return this.#verifiedNativeBranch(await this.#nativeBranches(), name, notBefore, notAfter);
  }

  async prepareNativeBranch(
    ref: string, expected: NativeNeonBranch, notBefore: number, pr: number, standingBranchId: string,
    peerRefs: readonly string[], verifyCurrent: VerifyCurrent, notAfter?: number,
  ): Promise<void> {
    previewDatabaseEnvironmentId(pr);
    const name = nativeBranchName(ref, notBefore, notAfter);
    const peerNames = peerRefs.map(peer => nativeBranchName(peer));
    if (peerNames.includes(name) || new Set(peerNames).size !== peerNames.length
      || standingBranchId === this.#config.parentBranchId) {
      throw new Error("Neon Native Preview の比較対象が一致しません。");
    }

    const inventory = await this.#nativeBranches();
    const child = await this.#verifiedNativeBranch(inventory, name, notBefore, notAfter);
    if (!child || !sameNativeBranch(child, expected)) throw new Error("Neon Native Preview の専用接続先が一致しません。");
    const { roles, databases } = await this.#postgresResources(child.id);
    if (roles.length !== 1 || roles[0].name !== templateRole || roles[0].protected
      || databases.length !== 1 || databases[0].name !== templateDatabase || databases[0].owner_name !== templateRole) {
      throw new Error("Neon Native Preview の標準 DB とロールが一致しません。");
    }

    const connection = await nativePilotStage("neon-isolation", async () => {
      const [template, standing, ...peers] = await Promise.all([
        this.#nativeRoot(this.#config.parentBranchId, templateName, true), this.#nativeRoot(standingBranchId, "main", false),
        ...peerNames.map(peer => this.#verifiedNativeBranch(inventory, peer)),
      ]);
      const otherBranches = [template, standing, ...peers].filter(other => other !== null);
      const endpoints = new Set([child, ...otherBranches].map(item => item.endpointId));
      if (otherBranches.length !== peerNames.length + 2 || endpoints.size !== otherBranches.length + 1) {
        throw new Error("Neon Native Preview の比較対象を確認できません。");
      }
      const childConnection = await this.#connection(child.id, templateDatabase, templateRole, child);
      const password = nativePassword(childConnection.connectionString);
      for (const other of otherBranches) {
        const otherConnection = await this.#connection(other.id, templateDatabase, templateRole, other);
        if (nativePassword(otherConnection.connectionString) === password) {
          throw new NativePilotStageError("neon-shared-credentials", new Error("Neon Native Preview のロール資格情報が共有されています。"));
        }
      }
      return childConnection;
    });

    await nativePilotStage("github-target", verifyCurrent);
    await nativePilotStage("neon-initialize", async () => {
      try {
        await preparePreviewDatabase({ pr, ...connection, initialize: true });
      } catch {
        throw new Error("Neon Native Preview の DB 照合・migration・seed を確認できません。");
      }
    });
  }

  async #requireNativeAbsent<T>(path: string, schema: z.ZodType<T>): Promise<void> {
    try {
      await this.#request(path, schema);
    } catch (error) {
      if (error instanceof NeonRequestError && error.status === 404) return;
      throw error;
    }
    throw new Error("Neon Native Preview の専用資源を直接取得できる状態です。");
  }

  async removeNativeBranch(
    ref: string, expected: NativeNeonBranch, notBefore: number, verifyCurrent: VerifyCurrent, notAfter?: number,
  ): Promise<void> {
    const name = nativeBranchName(ref, notBefore, notAfter);
    if (!nativeIdentity.safeParse(expected).success || !isNativeDirectHost(expected.endpointId, expected.host)
      || expected.id === this.#config.parentBranchId) {
      throw new Error("Neon Native Preview の削除対象が無効です。");
    }
    const branches = await this.#nativeBranches();
    const child = await this.#verifiedNativeBranch(branches, name, notBefore, notAfter);
    if (child) {
      if (!sameNativeBranch(child, expected) || branches.some(item => item.parent_id === expected.id)) {
        throw new Error("Neon Native Preview の削除対象が一致しません。");
      }
      const removed = await this.#request(`/branches/${expected.id}`, branchChange, "DELETE", undefined, verifyCurrent)
        .catch((error: unknown) => {
          if (error instanceof NeonRequestError && error.status === 404) return null;
          throw error;
        });
      if (removed) {
        this.#assertNativeChild(removed.branch, name);
        if (removed.branch.id !== expected.id) throw new Error("削除した Neon Native Preview ブランチが一致しません。");
        await this.#waitOperations(removed, expected.id);
      }
    }

    const [remaining, endpoints] = await Promise.all([this.#nativeBranches(), this.#nativeEndpoints()]);
    if (remaining.some(item => item.id === expected.id || item.parent_id === expected.id || item.name === name)
      || endpoints.some(item => item.project_id !== this.#config.projectId || item.id === expected.endpointId
        || item.branch_id === expected.id || item.host === expected.host)) {
      throw new Error("Neon Native Preview の専用資源が一覧に残っています。");
    }
    await Promise.all([
      this.#requireNativeAbsent(`/branches/${expected.id}`, branchDetails),
      this.#requireNativeAbsent(`/endpoints/${expected.endpointId}`, z.object({ endpoint })),
    ]);
  }

  async ensure(pr: number, verifyCurrent?: VerifyCurrent, migrations?: readonly MigrationSource[]) {
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
      await this.#assertEmptyTemplate();
      const created = await this.#request("/branches", branchChange, "POST", {
        branch: { name, parent_id: this.#config.parentBranchId, init_source: "parent-data" },
        endpoints: [{ type: "read_write", autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 }],
        annotation_value: this.#annotation(pr),
      }, verifyCurrent);
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
      const result = await this.#request(`/branches/${id}/roles`, operations.extend({ role }), "POST", {
        role: { name: expectedRole },
      }, verifyCurrent);
      if (result.role.name !== expectedRole || result.role.branch_id !== id || result.role.protected) {
        throw new Error("作成した Neon ロールを照合できません。");
      }
      await this.#waitOperations(result, id);
    }
    if (!databases[0]) {
      const result = await this.#request(`/branches/${id}/databases`, operations.extend({ database }), "POST", {
        database: { name: expectedDatabase, owner_name: expectedRole },
      }, verifyCurrent);
      if (result.database.name !== expectedDatabase || result.database.branch_id !== id || result.database.owner_name !== expectedRole) {
        throw new Error("作成した Neon DB を照合できません。");
      }
      await this.#waitOperations(result, id);
    }
    const connection = await this.#connection(id, expectedDatabase, expectedRole);
    await verifyCurrent?.();
    try {
      // The provider annotation proves ownership across runs. The existing SQL initializes
      // only an empty DB and otherwise requires the exact Mille PR marker and migration history.
      await preparePreviewDatabase({ pr, ...connection, initialize: true, migrations });
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
    const removed = await this.#request(`/branches/${id}`, branchChange, "DELETE", undefined, verifyCurrent);
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
