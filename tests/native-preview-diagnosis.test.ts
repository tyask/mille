import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseNativePreview, formatNativePreviewDiagnosis } from "../scripts/preview/diagnose-native";

const teamId = "team_Fixture";
const vercelProjectId = "prj_Fixture";
const neonProjectId = "native-project-123";
const template = { id: "br-fixture-template", project_id: neonProjectId, name: "mille-pr-template", default: false,
  parent_id: null, protected: false, current_state: "ready", pending_state: null };
const standing = { ...template, id: "br-fixture-standing", name: "main", default: true };
const region = "aws-ap-southeast-1";
const templateEndpoint = { id: "ep-fixture-template", project_id: neonProjectId, branch_id: template.id,
  region_id: region, type: "read_write", disabled: false, host: "ep-fixture-template.ap-southeast-1.aws.neon.tech" };
const standingEndpoint = { ...templateEndpoint, id: "ep-fixture-standing", branch_id: standing.id,
  host: "ep-fixture-standing.ap-southeast-1.aws.neon.tech" };
const vercelProject = {
  id: vercelProjectId, accountId: teamId, name: "mille",
  link: { type: "github", repoId: 1436928292, productionBranch: "main" },
  framework: "nextjs", nodeVersion: "24.x", autoExposeSystemEnvs: true,
  ssoProtection: { deploymentType: "preview" },
};
const providerSecret = "sensitive-provider-fixture-must-not-appear";
const templateUri = `postgresql://neondb_owner:${providerSecret}@${templateEndpoint.host}/neondb?sslmode=require`;
const env = {
  VERCEL_TOKEN: "vercel-test-token",
  NEON_API_KEY: "neon-test-token",
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: teamId,
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: vercelProjectId,
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: neonProjectId,
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: template.id,
  MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID: "org-fixture-123",
  MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: standing.id,
  MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: standingEndpoint.id,
};
const vercelOrigin = "https://api.vercel.com";
const neonOrigin = "https://console.neon.tech";
const vercelProjectPath = `/v9/projects/${vercelProjectId}`;
const environmentPath = `/v10/projects/${vercelProjectId}/env?decrypt=false`;
const deploymentsPath = `/v6/deployments?projectId=${vercelProjectId}&limit=100`;
const aliasAPath = "/v4/aliases/mille-git-codex-native-preview-pilot-a-fumin1.vercel.app";
const aliasBPath = "/v4/aliases/mille-git-codex-native-preview-pilot-b-fumin1.vercel.app";
const neonProjectPath = `/api/v2/projects/${neonProjectId}`;
const branchesPath = `${neonProjectPath}/branches?limit=100`;
const endpointsPath = `${neonProjectPath}/endpoints`;
const templatePath = `${neonProjectPath}/branches/${template.id}`;
const standingPath = `${neonProjectPath}/branches/${standing.id}`;
const templateEndpointsPath = `${templatePath}/endpoints`;
const standingEndpointsPath = `${standingPath}/endpoints`;
const databasesPath = `${templatePath}/databases`;
const rolesPath = `${templatePath}/roles`;
const connectionUriPath = `${neonProjectPath}/connection_uri?${new URLSearchParams({
  branch_id: template.id, endpoint_id: templateEndpoint.id, database_name: "neondb", role_name: "neondb_owner", pooled: "false",
})}`;

function scenario(overrides: Record<string, Response> = {}) {
  const responses: Record<string, Response> = {
    [vercelProjectPath]: Response.json(vercelProject),
    [environmentPath]: Response.json({ envs: [
      { key: "STANDING_ONLY", target: ["preview"], gitBranch: "mille-standing-preview", value: providerSecret },
      { key: "PRODUCTION_ONLY", target: ["production"], gitBranch: null, value: providerSecret },
    ] }),
    [deploymentsPath]: Response.json({ deployments: [], pagination: { count: 0, next: null } }),
    [aliasAPath]: new Response(null, { status: 404 }),
    [aliasBPath]: new Response(null, { status: 404 }),
    [neonProjectPath]: Response.json({ project: { id: neonProjectId, org_id: env.MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID,
      name: "mille-preview", region_id: region, creation_source: "vercel_marketplace" } }),
    [branchesPath]: Response.json({ branches: [template, standing], pagination: { next: null } }),
    [endpointsPath]: Response.json({ endpoints: [templateEndpoint, standingEndpoint] }),
    [templatePath]: Response.json({ branch: template }),
    [standingPath]: Response.json({ branch: standing }),
    [templateEndpointsPath]: Response.json({ endpoints: [templateEndpoint] }),
    [standingEndpointsPath]: Response.json({ endpoints: [standingEndpoint] }),
    [databasesPath]: Response.json({ databases: [{ branch_id: template.id, name: "neondb", owner_name: "neondb_owner" }] }),
    [rolesPath]: Response.json({ roles: [{ branch_id: template.id, name: "neondb_owner", protected: false }] }),
    [connectionUriPath]: Response.json({ uri: templateUri }),
    ...overrides,
  };
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const vercel = !url.pathname.startsWith("/api/v2/");
    if (vercel) {
      assert.equal(url.searchParams.get("teamId"), teamId);
      url.searchParams.delete("teamId");
    }
    const path = `${url.pathname}${url.search}`;
    requests.push(path);
    assert.equal(url.origin, vercel ? vercelOrigin : neonOrigin);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${vercel ? env.VERCEL_TOKEN : env.NEON_API_KEY}`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.body ?? null, null);
    assert.equal(init?.redirect, "error");
    assert.ok(Object.hasOwn(responses, path), path);
    return responses[path].clone();
  };
  return { request, requests, expectedPaths: Object.keys(responses).sort() };
}

function assertSafeOutput(checks: Awaited<ReturnType<typeof diagnoseNativePreview>>) {
  const output = formatNativePreviewDiagnosis(checks);
  const serialized = JSON.stringify(checks);
  for (const sensitive of [providerSecret, env.VERCEL_TOKEN, env.NEON_API_KEY, vercelOrigin, neonOrigin, "postgresql://"]) {
    assert.ok(!output.includes(sensitive));
    assert.ok(!serialized.includes(sensitive));
  }
  return output;
}

test("既存の資格情報と両プロバイダーの固定 GET で復旧済み構成を診断する", async () => {
  const fixture = scenario();
  const checks = await diagnoseNativePreview(env, fixture.request);
  assert.ok(checks.length > 0 && checks.every(check => check.ok));
  assert.deepEqual(fixture.requests.sort(), fixture.expectedPaths);
  assertSafeOutput(checks);
});

test("Vercel の HTTP 拒否と応答形式の不一致を区別し、秘密値を出力しない", async () => {
  const denied = scenario({ [aliasAPath]: Response.json({ error: providerSecret }, { status: 403 }) });
  const deniedChecks = await diagnoseNativePreview(env, denied.request);
  const deniedCheck = deniedChecks.find(check => !check.ok && check.status === 403);
  assert.ok(deniedCheck);
  assert.match(assertSafeOutput(deniedChecks), /403/);

  const malformed = scenario({ [environmentPath]: Response.json({ envs: providerSecret }) });
  const malformedChecks = await diagnoseNativePreview(env, malformed.request);
  const malformedCheck = malformedChecks.find(check => !check.ok);
  assert.ok(malformedCheck);
  assert.notEqual(malformedCheck.name, deniedCheck.name);
  assert.notEqual(malformedCheck.status, 403);
  assertSafeOutput(malformedChecks);
});

test("Vercel プロジェクトの対象違いと不適合な保護・Preview 環境を診断する", async () => {
  for (const change of [
    { id: "prj_Other" },
    { accountId: "team_Other" },
    { link: { ...vercelProject.link, repoId: 1 } },
    { protectionBypass: { [providerSecret]: {} } },
    { env: [{ key: "MILLE_NATIVE_PREVIEW_DATABASE_URL", target: ["preview"], value: providerSecret }] },
    { env: [{ key: "MILLE_NATIVE_PREVIEW_DATABASE_URL", target: ["production"], value: providerSecret }] },
  ]) {
    const fixture = scenario({ [vercelProjectPath]: Response.json({ ...vercelProject, ...change }) });
    const checks = await diagnoseNativePreview(env, fixture.request);
    assert.ok(checks.some(check => check.name === "Vercel プロジェクト" && !check.ok && check.status === 200));
    assertSafeOutput(checks);
  }
});

test("全 Preview に適用される環境変数、Native 専用変数の残存、不完全な一覧を診断する", async () => {
  for (const response of [
    { envs: [{ key: "PREVIEW_ONLY", target: ["preview"], value: providerSecret }] },
    { envs: [{ key: "MILLE_NATIVE_PREVIEW_DATABASE_URL", target: ["production"], value: providerSecret }] },
    { envs: [{ key: "MILLE_NATIVE_PREVIEW_DATABASE_URL", target: ["preview"], gitBranch: "mille-standing-preview" }] },
    { envs: [], pagination: { count: 1 } },
  ]) {
    const fixture = scenario({ [environmentPath]: Response.json(response) });
    const checks = await diagnoseNativePreview(env, fixture.request);
    assert.deepEqual(checks.filter(check => !check.ok),
      [{ name: "Vercel 環境変数メタデータ", ok: false, status: 200 }]);
    assertSafeOutput(checks);
  }
});

test("Neon の一覧取得に成功してもブランチ別エンドポイントの HTTP 拒否を診断する", async () => {
  const fixture = scenario({ [standingEndpointsPath]: Response.json({ error: providerSecret }, { status: 403 }) });
  const checks = await diagnoseNativePreview(env, fixture.request);
  assert.ok(checks.some(check => check.name === "Neon エンドポイント一覧" && check.ok));
  const deniedCheck = checks.find(check => !check.ok && check.status === 403);
  assert.ok(deniedCheck);
  assert.match(deniedCheck.name, /Neon.*(?:エンドポイント|接続先)/);
  assert.match(assertSafeOutput(checks), /403/);
});

test("Neon の接続 URI 取得の拒否と別ホストの URI を区別し、資格情報を出力しない", async () => {
  const wrongHost = templateUri.replace(templateEndpoint.host, "untrusted-preview.example.invalid");
  const responses = [
    Response.json({ uri: templateUri }, { status: 403 }),
    Response.json({ uri: wrongHost }),
  ];
  for (const response of responses) {
    const fixture = scenario({ [connectionUriPath]: response });
    const checks = await diagnoseNativePreview(env, fixture.request);
    assert.ok(fixture.requests.includes(connectionUriPath));
    const failedCheck = checks.find(check => !check.ok && check.status === response.status);
    assert.ok(failedCheck);
    assert.match(failedCheck.name, /Neon.*接続/);
    assertSafeOutput(checks);
  }
});

test("Neon の DB 一覧に失敗した場合は未照合のロールを成功と扱わない", async () => {
  const fixture = scenario({ [databasesPath]: Response.json({ error: providerSecret }, { status: 403 }) });
  const checks = await diagnoseNativePreview(env, fixture.request);
  assert.deepEqual(checks.filter(check => !check.ok), [{ name: "Neon テンプレート DB", ok: false, status: 403 }]);
  assert.ok(!fixture.requests.includes(rolesPath));
  assert.ok(fixture.requests.includes(aliasAPath));
  assertSafeOutput(checks);
});

test("無効な対象や不足する資格情報は通信前に拒否する", async () => {
  const overrides = [
    { MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: `prj_Fixture?secret=${providerSecret}` },
    { MILLE_PR_PREVIEW_NEON_PROJECT_ID: "//example.invalid" },
    { VERCEL_TOKEN: undefined },
    { NEON_API_KEY: undefined },
  ];
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    throw Error("無効な設定で通信しました。");
  };
  for (const override of overrides) {
    const checks = await diagnoseNativePreview({ ...env, ...override }, request);
    assert.ok(checks.some(check => !check.ok));
    assertSafeOutput(checks);
  }
  assert.equal(requests, 0);
});
