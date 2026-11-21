import assert from "node:assert/strict";
import test from "node:test";
import { inspectDetachedNativeResource, NativeResourceInspectionError } from "../scripts/preview/native-resource";

const config = {
  teamId: "team_Fixture",
  storeId: "store_Fixture",
  integrationId: "icfg_Fixture",
  productId: "iap_Fixture",
  neonProjectId: "native-project-123",
  neonOrganizationId: "org-fixture-123",
};
const root = {
  id: "br-fixture-root", project_id: config.neonProjectId, default: true,
  parent_id: null, current_state: "ready", pending_state: null,
};
const endpoint = {
  id: "ep-fixture", project_id: config.neonProjectId, branch_id: root.id, region_id: "aws-ap-southeast-1",
  type: "read_write", disabled: false, host: "ep-fixture.c-2.ap-southeast-1.aws.neon.tech",
};
const database = { branch_id: root.id, name: "neondb", owner_name: "neondb_owner" };
const role = { branch_id: root.id, name: "neondb_owner", protected: false };
const store = {
  id: config.storeId, ownerId: config.teamId, type: "integration", status: "available", name: "mille-native-preview",
  externalResourceId: config.neonProjectId, projectsMetadata: [] as unknown[], totalConnectedProjects: 0,
  product: { id: config.productId, slug: "neon", integrationConfigurationId: config.integrationId },
  billingPlan: { id: "free_v3", name: "Free" },
};
const project = {
  id: config.neonProjectId, org_id: config.neonOrganizationId, name: "mille-native-preview",
  region_id: "aws-ap-southeast-1", creation_source: "vercel_marketplace",
};

const storePath = `/v1/storage/stores/${config.storeId}`;
const projectPath = `/projects/${config.neonProjectId}`;
const branchesPath = `${projectPath}/branches?limit=100`;
const endpointsPath = `${projectPath}/endpoints`;
const databasesPath = `${projectPath}/branches/${root.id}/databases`;
const rolesPath = `${projectPath}/branches/${root.id}/roles`;
const rawSecret = "example-provider-secret-value";

function scenario(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [storePath]: { store: { ...store, credential: rawSecret } },
    [projectPath]: { project },
    [branchesPath]: { branches: [root], pagination: { next: null } },
    [endpointsPath]: { endpoints: [endpoint] },
    [databasesPath]: { databases: [database] },
    [rolesPath]: { roles: [{ ...role, password: rawSecret }] },
    ...overrides,
  };
  const requests: string[] = [];
  const reader = (provider: string) => async (path: string) => {
    requests.push(`${provider} ${path}`);
    assert.equal(provider, path === storePath ? "Vercel" : "Neon");
    assert.ok(Object.hasOwn(responses, path), path);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  };
  return { requests, readers: { vercel: reader("Vercel"), neon: reader("Neon") } };
}

function rejectsInspection(message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof NativeResourceInspectionError);
    assert.match(error.message, message);
    assert.ok(!error.message.includes(rawSecret));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("未接続の Native リソースを GET の照合だけで確認し、安全な識別情報を返す", async () => {
  const { readers, requests } = scenario();
  const result = await inspectDetachedNativeResource(config, readers);
  assert.deepEqual(result, {
    ...config, region: project.region_id, branchId: root.id, endpointId: endpoint.id,
    host: endpoint.host, database: database.name, role: role.name,
  });
  assert.deepEqual(requests, [
    `Vercel ${storePath}`, `Neon ${projectPath}`, `Neon ${branchesPath}`,
    `Neon ${endpointsPath}`, `Neon ${databasesPath}`, `Neon ${rolesPath}`,
  ]);
});

test("ストアの ID、所有、製品、接続先、Free プランの不一致を拒否する", async () => {
  const unsafe: Partial<typeof store>[] = [
    { id: "store_Foreign" }, { ownerId: "team_Foreign" }, { name: "mille-preview" }, { type: "postgres" },
    { status: "initializing" }, { externalResourceId: "foreign-neon-project" },
    { projectsMetadata: [{ projectId: "prj_Other" }] }, { projectsMetadata: undefined },
    { totalConnectedProjects: 1 }, { totalConnectedProjects: undefined },
    { product: { ...store.product, id: "iap_Foreign" } }, { product: { ...store.product, slug: "other" } },
    { product: { ...store.product, integrationConfigurationId: "icfg_Foreign" } },
    { billingPlan: { ...store.billingPlan, id: "paid", name: "Free" } }, { billingPlan: undefined },
  ];
  for (const change of unsafe) {
    const { readers, requests } = scenario({ [storePath]: { store: { ...store, ...change } } });
    await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/Vercel/));
    assert.deepEqual(requests, [`Vercel ${storePath}`]);
  }
});

test("Neon プロジェクトの ID、組織、地域、Marketplace の作成元を確認する", async () => {
  for (const change of [
    { id: "foreign-neon-project" }, { org_id: "org-foreign" }, { org_id: undefined }, { name: "mille-preview" },
    { region_id: "aws-us-east-2" }, { creation_source: "console" },
  ]) {
    const { readers, requests } = scenario({ [projectPath]: { project: { ...project, ...change } } });
    await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/専用 Native Preview プロジェクト/));
    assert.deepEqual(requests, [`Vercel ${storePath}`, `Neon ${projectPath}`]);
  }
});

test("単一で準備済みの既定 root を要求し、不完全な一覧を拒否する", async () => {
  for (const result of [
    { branches: [] }, { branches: [{ ...root, id: "br-" }] }, { branches: [root, { ...root, id: "br-extra" }] },
    { branches: [{ ...root, project_id: "foreign-neon-project" }] }, { branches: [{ ...root, default: false }] },
    { branches: [{ ...root, current_state: "init" }] }, { branches: [{ ...root, pending_state: "archived" }] },
    { branches: [{ ...root, parent_id: "br-foreign" }] },
    { branches: [root], pagination: { next: "next-page" } }, { branches: [root], pagination: { cursor: "next-page" } },
  ]) {
    const { readers, requests } = scenario({ [branchesPath]: result });
    await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/既定 root/));
    assert.equal(requests.at(-1), `Neon ${branchesPath}`);
  }
});

test("既定 root に属する正しい地域の有効な直接接続先だけを受け付ける", async () => {
  const unsafe = [
    { branch_id: "br-foreign" }, { project_id: "foreign-neon-project" }, { type: "read_only" }, { disabled: true },
    { region_id: "aws-us-east-2" }, { host: "ep-fixture.us-east-2.aws.neon.tech" },
    { host: "ep-other.ap-southeast-1.aws.neon.tech" }, { host: "ep-fixture-pooler.ap-southeast-1.aws.neon.tech" },
    { host: "ep-fixture.ap-southeast-1.aws.neon.tech.example.invalid" },
  ];
  for (const items of [[], [endpoint, endpoint], ...unsafe.map(change => [{ ...endpoint, ...change }])]) {
    const { readers, requests } = scenario({ [endpointsPath]: { endpoints: items } });
    await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/read-write/));
    assert.equal(requests.at(-1), `Neon ${endpointsPath}`);
  }
});

test("既定 root の標準 DB と所有ロールの一覧を確認する", async () => {
  for (const overrides of [
    { [databasesPath]: { databases: [{ ...database, branch_id: "br-foreign" }] } },
    { [databasesPath]: { databases: [{ ...database, name: "other" }] } },
    { [databasesPath]: { databases: [{ ...database, owner_name: "other" }] } },
    { [databasesPath]: { databases: [database, { ...database, name: "other" }] } },
    { [rolesPath]: { roles: [{ ...role, branch_id: "br-foreign" }] } },
    { [rolesPath]: { roles: [{ ...role, name: "other" }] } },
    { [rolesPath]: { roles: [role, { ...role, name: "other" }] } },
  ]) {
    const { readers } = scenario(overrides);
    await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/標準 DB と所有ロール/));
  }
});

test("無効な設定は通信前に拒否し、プロバイダーの応答やエラーの詳細を伏せる", async () => {
  const invalid = scenario();
  await assert.rejects(inspectDetachedNativeResource({ ...config, storeId: "other?decrypt=true" }, invalid.readers),
    rejectsInspection(/照合設定/));
  assert.deepEqual(invalid.requests, []);

  for (const path of [storePath, projectPath, rolesPath]) {
    for (const response of [new Error(rawSecret), { error: rawSecret }]) {
      const { readers } = scenario({ [path]: response });
      await assert.rejects(inspectDetachedNativeResource(config, readers), rejectsInspection(/確認できません/));
    }
  }
});
