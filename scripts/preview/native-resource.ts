import { z } from "zod";

const resourceName = "mille-preview";
const templateName = "mille-pr-template";
const standingName = "main";
const legacyBranchName = /^mille-pr-[1-9][0-9]*$/;
const region = "aws-ap-southeast-1";
const vercelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const neonId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
const branchId = neonId.refine(id => /^br-[a-z0-9]/.test(id));
const endpointId = neonId.refine(id => /^ep-[a-z0-9]/.test(id) && !id.endsWith("-pooler"));
const configuration = z.object({
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
  storeId: vercelId,
  integrationId: vercelId,
  productId: vercelId,
  neonProjectId: neonId,
  neonOrganizationId: neonId.refine(id => /^org-[a-z0-9]/.test(id)),
  templateBranchId: branchId,
  standingBranchId: branchId,
  standingEndpointId: endpointId,
});

const storeDetails = z.object({ store: z.object({
  id: vercelId,
  ownerId: vercelId,
  type: z.literal("integration"),
  status: z.literal("available"),
  name: z.literal(resourceName),
  externalResourceId: neonId,
  projectsMetadata: z.tuple([]),
  totalConnectedProjects: z.literal(0),
  product: z.object({
    id: vercelId,
    slug: z.literal("neon"),
    integrationConfigurationId: vercelId,
  }),
  billingPlan: z.object({ id: z.literal("free_v3") }),
}) });

const projectDetails = z.object({ project: z.object({
  id: neonId,
  org_id: neonId,
  name: z.literal(resourceName),
  region_id: z.literal(region),
  creation_source: z.literal("vercel_marketplace"),
}) });

const terminalCursor = z.union([z.literal(""), z.null()]).optional();
const completeInventory = z.object({ next: terminalCursor, cursor: terminalCursor }).nullish();
const branchInventory = z.object({
  branches: z.array(z.object({
    id: branchId,
    project_id: neonId,
    name: z.string(),
    default: z.boolean(),
    parent_id: branchId.nullish(),
    current_state: z.string(),
    pending_state: z.string().nullish(),
  })),
  pagination: completeInventory,
});

const endpointMetadata = z.object({
  id: endpointId,
  project_id: neonId,
  branch_id: branchId,
  region_id: z.string().min(1),
  type: z.enum(["read_write", "read_only"]),
  disabled: z.boolean(),
  host: z.string().min(1),
});
const endpointInventory = z.object({
  endpoints: z.array(endpointMetadata),
  pagination: completeInventory,
});
const directHost = /^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*ap-southeast-1\.aws\.neon\.tech$/;

const databases = z.object({ databases: z.tuple([z.object({
  branch_id: branchId,
  name: z.literal("neondb"),
  owner_name: z.literal("neondb_owner"),
})]), pagination: completeInventory });

const roles = z.object({ roles: z.tuple([z.object({
  branch_id: branchId,
  name: z.literal("neondb_owner"),
  protected: z.literal(false).nullish(),
})]), pagination: completeInventory });

type Read = (path: string) => Promise<unknown>;

const messages = {
  configuration: "Native Preview 専用リソースの照合設定が無効です。",
  store: "Vercel の未接続 Native Preview リソースと Free プランを確認できません。",
  project: "Neon の Native Preview 用プロジェクトを確認できません。",
  branch: "Neon の常設ブランチと PR 用テンプレートの分離を確認できません。",
  endpoint: "Neon の直接接続用 read-write エンドポイントを確認できません。",
  database: "Neon の標準 DB と所有ロールを確認できません。",
} as const;

export class NativeResourceInspectionError extends Error {
  constructor(stage: keyof typeof messages) {
    super(messages[stage]);
    this.name = "NativeResourceInspectionError";
  }
}

async function readMetadata<T>(read: Read, path: string, schema: z.ZodType<T>, stage: keyof typeof messages): Promise<T> {
  let response: unknown;
  try {
    response = await read(path);
  } catch {
    throw new NativeResourceInspectionError(stage);
  }
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new NativeResourceInspectionError(stage);
  return parsed.data;
}

function verifiedRootEndpoint(endpoints: readonly z.infer<typeof endpointMetadata>[], rootId: string) {
  const matches = endpoints.filter(endpoint => endpoint.branch_id === rootId);
  const [endpoint] = matches;
  if (matches.length !== 1 || endpoint.type !== "read_write" || endpoint.disabled || endpoint.region_id !== region
    || !directHost.test(endpoint.host) || endpoint.host.split(".")[0] !== endpoint.id) {
    throw new NativeResourceInspectionError("endpoint");
  }
  return endpoint;
}

export async function inspectDetachedNativeResource(
  config: z.input<typeof configuration>, readers: { vercel: Read; neon: Read },
) {
  const parsed = configuration.safeParse(config);
  if (!parsed.success) throw new NativeResourceInspectionError("configuration");
  const { teamId, storeId, integrationId, productId, neonProjectId, neonOrganizationId,
    templateBranchId, standingBranchId, standingEndpointId } = parsed.data;
  if (templateBranchId === standingBranchId) throw new NativeResourceInspectionError("configuration");

  const { store } = await readMetadata(readers.vercel, `/v1/storage/stores/${storeId}`, storeDetails, "store");
  if (store.id !== storeId || store.ownerId !== teamId || store.externalResourceId !== neonProjectId
    || store.product.id !== productId || store.product.integrationConfigurationId !== integrationId) {
    throw new NativeResourceInspectionError("store");
  }

  const projectPath = `/projects/${neonProjectId}`;
  const { project } = await readMetadata(readers.neon, projectPath, projectDetails, "project");
  if (project.id !== neonProjectId || project.org_id !== neonOrganizationId) {
    throw new NativeResourceInspectionError("project");
  }

  const { branches } = await readMetadata(readers.neon, `${projectPath}/branches?limit=100`, branchInventory, "branch");
  const branchesById = new Map(branches.map(branch => [branch.id, branch]));
  const template = branchesById.get(templateBranchId);
  const standing = branchesById.get(standingBranchId);
  if (branchesById.size !== branches.length || new Set(branches.map(branch => branch.name)).size !== branches.length
    || branches.some(branch => branch.project_id !== neonProjectId)
    || template?.name !== templateName || standing?.name !== standingName
    || template.default === standing.default
    || [template, standing].some(branch => branch.parent_id != null || branch.pending_state != null || branch.current_state !== "ready")) {
    throw new NativeResourceInspectionError("branch");
  }
  const legacyBranches = branches.filter(branch => branch.id !== template.id && branch.id !== standing.id);
  if (legacyBranches.some(branch => branch.default || branch.parent_id !== template.id || !legacyBranchName.test(branch.name))) {
    throw new NativeResourceInspectionError("branch");
  }

  const { endpoints } = await readMetadata(readers.neon, `${projectPath}/endpoints`, endpointInventory, "endpoint");
  if (new Set(endpoints.map(endpoint => endpoint.id)).size !== endpoints.length
    || new Set(endpoints.map(endpoint => endpoint.host)).size !== endpoints.length
    || endpoints.some(endpoint => endpoint.project_id !== neonProjectId || !branchesById.has(endpoint.branch_id))) {
    throw new NativeResourceInspectionError("endpoint");
  }
  const templateEndpoint = verifiedRootEndpoint(endpoints, template.id);
  const standingEndpoint = verifiedRootEndpoint(endpoints, standing.id);
  if (standingEndpoint.id !== standingEndpointId) throw new NativeResourceInspectionError("endpoint");

  const branchPath = `${projectPath}/branches/${template.id}`;
  const [{ databases: [database] }, { roles: [role] }] = await Promise.all([
    readMetadata(readers.neon, `${branchPath}/databases`, databases, "database"),
    readMetadata(readers.neon, `${branchPath}/roles`, roles, "database"),
  ]);
  if (database.branch_id !== template.id || role.branch_id !== template.id) throw new NativeResourceInspectionError("database");

  return { teamId, storeId, integrationId, productId, neonProjectId, neonOrganizationId, region: project.region_id,
    branchId: template.id, endpointId: templateEndpoint.id, host: templateEndpoint.host, database: database.name, role: role.name,
    currentDefaultBranchId: template.default ? template.id : standing.id, templateIsDefault: template.default,
    standingBranchId: standing.id, standingEndpointId: standingEndpoint.id, standingHost: standingEndpoint.host };
}
