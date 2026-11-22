import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readPreviewStatus } from "../scripts/preview/status";

const repository = { id: 1436928292, full_name: "tyask/mille" };
const pr = 8;
const sha = "a".repeat(40);
const ref = "codex/preview-status";
const pilotRef = "codex/native-preview-pilot-a";
const createdAt = "2026-11-22T00:00:00Z";
const environment = {
  VERCEL_TOKEN: "fixture-vercel-token", NEON_API_KEY: "fixture-neon-key",
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: "team_Fixture", MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: "prj_Fixture",
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: "fixture-preview", MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: "br-template",
  MILLE_PR_PREVIEW_MAX_BRANCHES: "2",
};
const project = {
  id: environment.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID, accountId: environment.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
  name: "mille", framework: "nextjs", nodeVersion: "24.x", autoExposeSystemEnvs: true,
  link: { type: "github", repoId: repository.id, productionBranch: "main" },
  ssoProtection: { deploymentType: "preview" },
};
const parent = {
  id: environment.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID, project_id: environment.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
  name: "mille-pr-template", default: false, protected: false, current_state: "ready",
};
const child = { ...parent, id: "br-dedicated", name: "mille-pr-8", parent_id: parent.id, init_source: "parent-data" };
const endpoint = { id: "ep-dedicated", project_id: parent.project_id, branch_id: child.id,
  host: "ep-dedicated.example.neon.tech", type: "read_write", disabled: false };
const hostDigest = createHash("sha256").update(endpoint.host).digest("hex");
const ownership = { object: { id: child.id }, value: {
  mille_repository: repository.full_name, mille_pr: String(pr), mille_database: "mille_pr", mille_role: "mille_pr_owner",
} };
const deployment = {
  id: "dpl_Fixture", projectId: project.id, ownerId: project.accountId, name: project.name,
  url: "mille-exact-fixture.vercel.app", public: false, readyState: "READY", createdAt: Date.parse(createdAt) + 2,
  meta: { millePreviewProtocol: "mille-pr-preview/v1", millePreviewRepository: repository.full_name,
    millePreviewPr: String(pr), millePreviewSha: sha, millePreviewDbHostHash: hostDigest },
};
const generation = "01234567-89ab-4def-8123-456789abcdef";
const nativeDeployment = {
  ...deployment,
  ready: Date.parse(createdAt) + 3,
  gitSource: { type: "github", repoId: repository.id, ref: pilotRef, sha },
  meta: {
    milleNativePilotProtocol: "mille-native-preview-pilot/v1", milleNativePilotRepository: repository.full_name,
    milleNativePilotPr: String(pr), milleNativePilotRef: pilotRef, milleNativePilotSha: sha,
    milleNativePilotGeneration: generation, milleNativePilotRequestedAt: String(Date.parse(createdAt) + 1),
    milleNativePilotPhase: "application", milleNativePilotBranchId: child.id,
    milleNativePilotEndpointId: endpoint.id, milleNativePilotHostDigest: hostDigest,
  },
};

const provider = {
  neon: `/api/v2/projects/${parent.project_id}`,
  vercel: `/v9/projects/${project.id}`,
  environments: `/v10/projects/${project.id}/env`,
  inventory: "/v6/deployments",
  deployment: `/v13/deployments/${deployment.id}`,
  build: `/v3/deployments/${deployment.id}/events`,
};
const childPath = `${provider.neon}/branches/${child.id}`;

function fixture(native = false) {
  const targetRef = native ? pilotRef : ref;
  const current = { number: pr, state: "open", closed_at: null, merged: false, merge_commit_sha: null, created_at: createdAt,
    head: { ref: targetRef, sha, repo: repository }, base: { ref: "main", sha: "b".repeat(40), repo: repository } };
  const github = [current, current];
  const selectedBranch = native ? { ...child, name: `preview/${pilotRef}`, created_at: createdAt } : child;
  const selectedDeployment = native ? nativeDeployment : deployment;
  const responses = new Map<string, unknown>([
    [provider.neon, { project: { id: parent.project_id, name: "mille-preview" } }],
    [`${provider.neon}/branches/${parent.id}`, { branch: parent }],
    [`${provider.neon}/branches`, { branches: [parent, selectedBranch] }],
    [childPath, { branch: selectedBranch, annotation: ownership }],
    [`${childPath}/endpoints`, { endpoints: [endpoint] }],
    [provider.vercel, project],
    [provider.environments, { envs: native ? [{ key: "MILLE_NATIVE_PREVIEW_DATABASE_URL", target: ["preview"],
      contentHint: { type: "integration-store-secret" } }] : [] }],
    [provider.inventory, { deployments: [{ uid: selectedDeployment.id, projectId: project.id,
      meta: selectedDeployment.meta }], pagination: { count: 1, next: null } }],
    [provider.deployment, selectedDeployment],
    [`/v2/deployments/${deployment.id}/aliases`, { aliases: [] }],
    ["/v4/aliases/mille-git-codex-native-preview-pilot-a-fumin1.vercel.app", null],
    [provider.build, [{ deploymentId: deployment.id, type: "stdout", info: { type: "build" },
      text: `Mille: Native Preview アプリビルド照合 v1 ${deployment.id} ${pr} ${pilotRef} ${sha} ${generation} ${endpoint.id}` }]],
  ]);
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.ok(input instanceof URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    if (input.origin === "https://api.vercel.com") {
      assert.equal(input.searchParams.get("teamId"), project.accountId);
      if (input.pathname === provider.environments) assert.equal(input.searchParams.get("decrypt"), "false");
    } else assert.equal(input.origin, "https://console.neon.tech");
    calls.push(input.pathname);
    assert.ok(responses.has(input.pathname), `予定外の読取先: ${input.pathname}`);
    const response = responses.get(input.pathname);
    return response === null ? new Response(null, { status: 404 }) : Response.json(response);
  };
  const run = () => readPreviewStatus({ pr, sha, environment: native ? { ...environment,
    MILLE_PR_PREVIEW_MODE: "native-pilot", MILLE_NATIVE_PREVIEW_PILOTS: "8,9" } : environment,
  read: async path => {
    assert.equal(path, `pulls/${pr}`);
    calls.push(path);
    return github.shift();
  } }, { request });
  return { run, responses, calls, current, github };
}

test("現 HEAD の旧方式 Preview と DB を GET だけで照合し、許可した項目だけを返す", async () => {
  const { run, calls } = fixture();
  assert.deepEqual(await run(), { pr, ref, sha, deploymentId: deployment.id, origin: `https://${deployment.url}`, mode: "legacy",
    database: { branchId: child.id, endpointId: endpoint.id, generation: child.id } });
  assert.equal(calls[0], `pulls/${pr}`);
  assert.equal(calls.at(-1), `pulls/${pr}`);
  assert.equal(calls.filter(path => path === `pulls/${pr}`).length, 2);
  assert.ok(calls.includes(provider.deployment));
  assert.ok(calls.includes(`${childPath}/endpoints`));
});

test("開始時の別所属と、状態確認中に変わった HEAD を拒否する", async () => {
  const other = fixture();
  other.github[0] = { ...other.current, head: { ...other.current.head, repo: { ...repository, id: repository.id + 1 } } };
  await assert.rejects(other.run(), /PR ソース/);
  assert.deepEqual(other.calls, [`pulls/${pr}`]);
  const moved = fixture();
  moved.github[1] = { ...moved.current, head: { ...moved.current.head, sha: "c".repeat(40) } };
  await assert.rejects(moved.run(), /PR ソース/);
  assert.ok(moved.calls.includes(provider.deployment));
  assert.equal(moved.calls.at(-1), `pulls/${pr}`);
});

test("Neon 所有、接続先 digest、現 HEAD の READY を証明できなければ拒否する", async () => {
  const cases: [string, unknown, RegExp][] = [
    [childPath, { branch: child, annotation: { ...ownership, value: { ...ownership.value, mille_pr: "9" } } }, /所有/],
    [`${childPath}/endpoints`, { endpoints: [{ ...endpoint, disabled: true }] }, /read-write/],
    [provider.deployment, { ...deployment, meta: { ...deployment.meta, millePreviewDbHostHash: "d".repeat(64) } }, /READY/],
    [provider.deployment, { ...deployment, readyState: "BUILDING" }, /READY/],
    [provider.deployment, { ...deployment, meta: { ...deployment.meta, millePreviewSha: "b".repeat(40) } }, /READY/],
  ];
  for (const [path, response, error] of cases) {
    const { run, responses } = fixture();
    responses.set(path, response);
    await assert.rejects(run(), error);
  }
});

test("Native アプリのビルド証拠と専用 branch・endpoint・世代を GET で照合する", async () => {
  const { run, calls } = fixture(true);
  assert.deepEqual(await run(), { pr, ref: pilotRef, sha, deploymentId: deployment.id,
    origin: `https://${deployment.url}`, mode: "native-pilot", database: { branchId: child.id, endpointId: endpoint.id, generation } });
  assert.ok(calls.includes(provider.build));
  assert.equal(calls.at(-1), `pulls/${pr}`);
});

test("Native アプリのビルド証拠や専用 branch が一致しなければ拒否する", async () => {
  const unknownBuild = fixture(true);
  unknownBuild.responses.set(provider.build, []);
  await assert.rejects(unknownBuild.run(), /ビルド照合記録/);
  const wrongChild = fixture(true);
  wrongChild.responses.set(provider.deployment, { ...nativeDeployment,
    meta: { ...nativeDeployment.meta, milleNativePilotBranchId: "br-other" } });
  await assert.rejects(wrongChild.run(), /専用 DB の所有/);
});
