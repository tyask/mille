import assert from "node:assert/strict";
import test from "node:test";
import { inspectNativePreviewNeonResource, NativeResourceInspectionError } from "../scripts/preview/native-resource";

const config = {
  neonProjectId: "native-project-123",
  neonOrganizationId: "org-fixture-123",
  templateBranchId: "br-fixture-template",
  standingBranchId: "br-fixture-standing",
  standingEndpointId: "ep-fixture-standing",
};
const template = {
  id: config.templateBranchId, project_id: config.neonProjectId, name: "mille-pr-template", default: false,
  parent_id: null as string | null, current_state: "ready", pending_state: null as string | null,
};
const standing = { ...template, id: config.standingBranchId, name: "main", default: true };
const legacy = { ...template, id: "br-legacy-child", name: "mille-pr-8", parent_id: template.id };
const branches = [template, standing];
const templateEndpoint = {
  id: "ep-fixture-template", project_id: config.neonProjectId, branch_id: template.id, region_id: "aws-ap-southeast-1",
  type: "read_write", disabled: false, host: "ep-fixture-template.c-2.ap-southeast-1.aws.neon.tech",
};
const standingEndpoint = { ...templateEndpoint, id: config.standingEndpointId, branch_id: standing.id,
  host: "ep-fixture-standing.ap-southeast-1.aws.neon.tech" };
const legacyEndpoint = { ...templateEndpoint, id: "ep-fixture-legacy", branch_id: legacy.id,
  host: "ep-fixture-legacy.ap-southeast-1.aws.neon.tech" };
const endpoints = [templateEndpoint, standingEndpoint];
const database = { branch_id: template.id, name: "neondb", owner_name: "neondb_owner" };
const role = { branch_id: template.id, name: "neondb_owner", protected: false };
const project = {
  id: config.neonProjectId, org_id: config.neonOrganizationId, name: "mille-preview",
  region_id: "aws-ap-southeast-1", creation_source: "vercel_marketplace",
};

const projectPath = `/projects/${config.neonProjectId}`;
const branchesPath = `${projectPath}/branches?limit=100`;
const endpointsPath = `${projectPath}/endpoints`;
const databasesPath = `${projectPath}/branches/${template.id}/databases`;
const rolesPath = `${projectPath}/branches/${template.id}/roles`;
const rawSecret = "example-provider-secret-value";

function scenario(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [projectPath]: { project },
    [branchesPath]: { branches, pagination: { next: null } },
    [endpointsPath]: { endpoints },
    [databasesPath]: { databases: [database] },
    [rolesPath]: { roles: [{ ...role, password: rawSecret }] },
    ...overrides,
  };
  const requests: string[] = [];
  const read = async (path: string) => {
    requests.push(path);
    assert.ok(Object.hasOwn(responses, path), path);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  };
  return { requests, read };
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

test("常設 main が既定の場合に Neon の構成を照合し、安全な識別情報を返す", async () => {
  const { read, requests } = scenario();
  const result = await inspectNativePreviewNeonResource(config, read);
  const { templateBranchId, ...expected } = config;
  assert.deepEqual(result, {
    ...expected, region: project.region_id, branchId: templateBranchId, endpointId: templateEndpoint.id,
    host: templateEndpoint.host, database: database.name, role: role.name,
    currentDefaultBranchId: standing.id, templateIsDefault: false, standingHost: standingEndpoint.host,
  });
  assert.deepEqual(requests, [projectPath, branchesPath, endpointsPath, databasesPath, rolesPath]);
});

test("テンプレートが既定になった場合も常設を区別し、既存の PR 用接続先は候補に混ぜない", async () => {
  const { read, requests } = scenario({
    [branchesPath]: { branches: [legacy, { ...standing, default: false }, { ...template, default: true }] },
    [endpointsPath]: { endpoints: [legacyEndpoint, ...endpoints, {
      ...legacyEndpoint, id: "ep-fixture-legacy-readonly", host: "ep-fixture-legacy-readonly.ap-southeast-1.aws.neon.tech",
      type: "read_only", disabled: true,
    }] },
  });
  const result = await inspectNativePreviewNeonResource(config, read);
  assert.equal(result.currentDefaultBranchId, template.id);
  assert.equal(result.templateIsDefault, true);
  assert.equal(result.endpointId, templateEndpoint.id);
  assert.equal(result.standingEndpointId, standingEndpoint.id);
  assert.deepEqual(requests.slice(-2), [databasesPath, rolesPath]);
});

test("Neon プロジェクトの ID、組織、地域、Marketplace の作成元を確認する", async () => {
  for (const change of [
    { id: "foreign-neon-project" }, { org_id: "org-foreign" }, { org_id: undefined }, { name: "mille-native-preview" },
    { region_id: "aws-us-east-2" }, { creation_source: "console" },
  ]) {
    const { read, requests } = scenario({ [projectPath]: { project: { ...project, ...change } } });
    await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/Native Preview 用プロジェクト/));
    assert.deepEqual(requests, [projectPath]);
  }
});

test("常設とテンプレートの独立した二つの root、単一の既定ブランチ、完全な一覧を要求する", async () => {
  for (const result of [
    { branches: [] }, { branches: [template] }, { branches: [template, { ...standing, id: "br-" }] },
    { branches: [template, { ...standing, project_id: "foreign-neon-project" }] },
    { branches: [template, { ...standing, default: false }] }, { branches: [{ ...template, default: true }, standing] },
    { branches: [{ ...template, current_state: "init" }, standing] },
    { branches: [template, { ...standing, pending_state: "archived" }] },
    { branches: [{ ...template, parent_id: standing.id }, standing] },
    { branches: [template, { ...standing, name: "staging" }] },
    { branches: [{ ...template, name: standing.name }, { ...standing, name: template.name }] },
    { branches, pagination: { next: "next-page" } }, { branches, pagination: { cursor: "next-page" } },
  ]) {
    const { read, requests } = scenario({ [branchesPath]: result });
    await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/常設ブランチと PR 用テンプレート/));
    assert.equal(requests.at(-1), branchesPath);
  }
});

test("不明な root、常設の子、孫ブランチ、重複 ID と名前を拒否する", async () => {
  for (const additional of [
    [{ ...legacy, parent_id: null }], [{ ...legacy, parent_id: standing.id }], [{ ...legacy, name: "preview/codex/old" }],
    [{ ...legacy, default: true }], [{ ...legacy, name: "mille-pr-08" }],
    [legacy, { ...legacy, id: "br-grandchild", name: "mille-pr-9", parent_id: legacy.id }],
    [legacy, { ...legacy, name: "mille-pr-9" }], [legacy, { ...legacy, id: "br-duplicate-name" }],
  ]) {
    const { read } = scenario({ [branchesPath]: { branches: [...branches, ...additional] } });
    await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/常設ブランチと PR 用テンプレート/));
  }
});

test("二つの root の独立した直接接続先と指定された常設エンドポイントだけを受け付ける", async () => {
  const unsafe = [
    { branch_id: "br-foreign" }, { project_id: "foreign-neon-project" }, { type: "read_only" }, { disabled: true },
    { region_id: "aws-us-east-2" }, { host: "ep-fixture-template.us-east-2.aws.neon.tech" },
    { host: "ep-other.ap-southeast-1.aws.neon.tech" }, { host: "ep-fixture-template-pooler.ap-southeast-1.aws.neon.tech" },
    { host: "ep-fixture-template.ap-southeast-1.aws.neon.tech.example.invalid" },
  ];
  for (const response of [
    { endpoints: [] }, { endpoints: [standingEndpoint, legacyEndpoint] },
    { endpoints: [...endpoints, { ...templateEndpoint, id: "ep-extra", host: "ep-extra.ap-southeast-1.aws.neon.tech" }] },
    { endpoints: [...endpoints, { ...legacyEndpoint, id: standingEndpoint.id }] },
    { endpoints: [...endpoints, { ...legacyEndpoint, host: templateEndpoint.host }] },
    { endpoints: [templateEndpoint, { ...standingEndpoint, id: "ep-other", host: "ep-other.ap-southeast-1.aws.neon.tech" }] },
    { endpoints, pagination: { next: "next-page" } },
    ...unsafe.map(change => ({ endpoints: [{ ...templateEndpoint, ...change }, standingEndpoint] })),
  ]) {
    const { read, requests } = scenario({
      [branchesPath]: { branches: [...branches, legacy] }, [endpointsPath]: response,
    });
    await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/read-write/));
    assert.equal(requests.at(-1), endpointsPath);
  }
});

test("PR 用テンプレートの標準 DB と所有ロールの一覧を確認する", async () => {
  for (const overrides of [
    { [databasesPath]: { databases: [{ ...database, branch_id: standing.id }] } },
    { [databasesPath]: { databases: [{ ...database, name: "other" }] } },
    { [databasesPath]: { databases: [{ ...database, owner_name: "other" }] } },
    { [databasesPath]: { databases: [database, { ...database, name: "other" }] } },
    { [rolesPath]: { roles: [{ ...role, branch_id: standing.id }] } },
    { [rolesPath]: { roles: [{ ...role, name: "other" }] } },
    { [rolesPath]: { roles: [role, { ...role, name: "other" }] } },
  ]) {
    const { read } = scenario(overrides);
    await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/標準 DB と所有ロール/));
  }
});

test("無効な設定は通信前に拒否し、プロバイダーの応答やエラーの詳細を伏せる", async () => {
  const invalid = scenario();
  await assert.rejects(inspectNativePreviewNeonResource({ ...config, neonProjectId: "other?secret=value" }, invalid.read),
    rejectsInspection(/照合設定/));
  await assert.rejects(inspectNativePreviewNeonResource({ ...config, templateBranchId: standing.id }, invalid.read),
    rejectsInspection(/照合設定/));
  assert.deepEqual(invalid.requests, []);

  for (const path of [projectPath, rolesPath]) {
    for (const response of [new Error(rawSecret), { error: rawSecret }]) {
      const { read } = scenario({ [path]: response });
      await assert.rejects(inspectNativePreviewNeonResource(config, read), rejectsInspection(/確認できません/));
    }
  }
});
