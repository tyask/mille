import { z } from "zod";

const resourceName = "mille-native-preview";
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
  branches: z.tuple([z.object({
    id: branchId,
    project_id: neonId,
    default: z.literal(true),
    parent_id: z.null().optional(),
    current_state: z.literal("ready"),
    pending_state: z.null().optional(),
  })]),
  pagination: completeInventory,
});

const endpointInventory = z.object({
  endpoints: z.tuple([z.object({
    id: endpointId,
    project_id: neonId,
    branch_id: branchId,
    region_id: z.literal(region),
    type: z.literal("read_write"),
    disabled: z.literal(false),
    host: z.string().regex(/^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*ap-southeast-1\.aws\.neon\.tech$/),
  })]),
  pagination: completeInventory,
});

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
  project: "Neon の専用 Native Preview プロジェクトを確認できません。",
  branch: "Neon の既定 root ブランチを確認できません。",
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

export async function inspectDetachedNativeResource(
  config: z.input<typeof configuration>, readers: { vercel: Read; neon: Read },
) {
  const parsed = configuration.safeParse(config);
  if (!parsed.success) throw new NativeResourceInspectionError("configuration");
  const { teamId, storeId, integrationId, productId, neonProjectId, neonOrganizationId } = parsed.data;

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

  const { branches: [root] } = await readMetadata(readers.neon, `${projectPath}/branches?limit=100`, branchInventory, "branch");
  if (root.project_id !== neonProjectId) throw new NativeResourceInspectionError("branch");

  const { endpoints: [endpoint] } = await readMetadata(readers.neon, `${projectPath}/endpoints`, endpointInventory, "endpoint");
  if (endpoint.project_id !== neonProjectId || endpoint.branch_id !== root.id || endpoint.host.split(".")[0] !== endpoint.id) {
    throw new NativeResourceInspectionError("endpoint");
  }

  const branchPath = `${projectPath}/branches/${root.id}`;
  const [{ databases: [database] }, { roles: [role] }] = await Promise.all([
    readMetadata(readers.neon, `${branchPath}/databases`, databases, "database"),
    readMetadata(readers.neon, `${branchPath}/roles`, roles, "database"),
  ]);
  if (database.branch_id !== root.id || role.branch_id !== root.id) throw new NativeResourceInspectionError("database");

  return { teamId, storeId, integrationId, productId, neonProjectId, neonOrganizationId, region: project.region_id,
    branchId: root.id, endpointId: endpoint.id, host: endpoint.host, database: database.name, role: role.name };
}
