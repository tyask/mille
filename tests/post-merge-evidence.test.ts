import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readPostMergeEvidence } from "../scripts/preview/post-merge-evidence";
import { standingPreviewAlias, standingProductionAliases } from "../scripts/preview/standing-vercel";

const repository = { id: 1436928292, full_name: "tyask/mille" };
const pr = { number: 7, headRef: "codex/example", headSha: "b".repeat(40), mergeSha: "a".repeat(40),
  mergedAt: "2026-11-23T04:00:00Z" };
const fixedOrigin = `https://${standingPreviewAlias}`;
const productionId = "dpl_Production";
const projectId = "prj_Mille";
const teamId = "team_Fixture";
const project = { id: projectId, name: "mille", accountId: teamId, link: { type: "github", repoId: repository.id, productionBranch: "main" },
  framework: "nextjs", nodeVersion: "24.x", autoExposeSystemEnvs: true, targets: { production: { id: productionId } },
  ssoProtection: { deploymentType: "all_except_custom_domains" } };
const release = { id: "dpl_Preview", origin: "https://mille-preview-new.vercel.app", sha: pr.mergeSha };
const legacy = { deploymentId: "dpl_PzqN4fUewyF6MtViekWrhWSb5juw", origin: "https://mille-hypzm5ss8-fumin1.vercel.app",
  sha: "7d8001aed54f1a1cec97f7071fbb31b4c9d99c2b" };
const database = { projectId: "billowing-cherry-59956184", branchId: "br-dark-rain-a1cc9tfa", endpointId: "ep-bitter-wind-a1atj6vn" };
const dbHost = `${database.endpointId}.ap-southeast-1.aws.neon.tech`;
const alias = { origin: fixedOrigin, id: "standing-alias-id" };
const receipt = { protocol: "mille-standing-preview/v1", runId: "1002", runAttempt: "2", controlSha: pr.mergeSha,
  ci: { runId: 1001, attempt: 3, jobId: 2001 }, production: { deploymentId: productionId,
    aliases: Object.fromEntries(standingProductionAliases.map(host => [host, productionId])) }, legacy, release, database, alias,
  browser: { runtimeSha: pr.mergeSha, durationMs: 1000, finishedAt: "2026-11-23T04:01:00Z",
    cases: ["desktop-user-a", "desktop-user-b", "mobile-user-a", "mobile-user-b"].map(name => ({ name, status: "passed" })) } };
const env = { GH_TOKEN: "fixture-gh-token", VERCEL_TOKEN: "fixture-vercel-token", NEON_API_KEY: "fixture-neon-token",
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: teamId, MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: projectId,
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: database.projectId, MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: "br-template", MILLE_PR_PREVIEW_MAX_BRANCHES: "7" };
const oidc = `fixture.${Buffer.from(JSON.stringify({ project_id: projectId, owner_id: teamId,
  environment: "development", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`;

function setup(options: { skippedCleanup?: boolean; oldProduction?: boolean; receiptOverride?: unknown;
  activeDeployment?: boolean; activeNeonBranch?: boolean; unprotected?: boolean } = {}) {
  const requests: string[] = [];
  const github: string[] = [];
  const result = { status: "completed", conclusion: "success" };
  const read = async (path: string): Promise<unknown> => {
    github.push(path);
    const workflow = /workflows\/([a-z-]+\.yml)\/runs/.exec(path)?.[1];
    if (workflow) {
      const ids = { "ci.yml": 1001, "standing-preview.yml": 1002, "pr-preview.yml": 1003 };
      assert.ok(workflow in ids);
      assert.ok(path.includes(`head_sha=${pr.mergeSha}`));
      return { total_count: 1, workflow_runs: [{ id: ids[workflow as keyof typeof ids], run_attempt: workflow === "standing-preview.yml" ? 2 : 3,
        head_branch: "main", head_sha: pr.mergeSha, repository, head_repository: repository, path: `.github/workflows/${workflow}`,
        event: "push", created_at: pr.mergedAt, ...result }] };
    }
    if (path === "actions/runs/1001/attempts/3/jobs") {
      return { total_count: 1, jobs: [{ id: 2001, run_id: 1001, run_attempt: 3, head_sha: pr.mergeSha,
        name: "check", ...result, steps: [{ name: "照合したソースとテスト対象を記録", ...result }] }] };
    }
    if (path === "actions/runs/1002/artifacts?name=mille-standing-preview-1002-2&per_page=100") {
      return { total_count: 1, artifacts: [{ id: 3002, name: "mille-standing-preview-1002-2", expired: false, size_in_bytes: 1000 }] };
    }
    if (path === "actions/runs/1003/attempts/3/jobs?per_page=100") {
      return { total_count: 1, jobs: [{ id: 2003, run_id: 1003, run_attempt: 3, head_sha: pr.mergeSha,
        name: `PR ${pr.number} cleanup`, ...result, steps: [{ name: `Confirm cleanup for ${pr.headSha}`, ...result,
          conclusion: options.skippedCleanup ? "skipped" : "success" }] }] };
    }
    return assert.fail(`未定義の GitHub リクエスト ${path}`);
  };
  const download = async (token: string, runId: number, name: string) => {
    assert.equal(token, env.GH_TOKEN);
    assert.equal(runId, 1002);
    assert.equal(name, "mille-standing-preview-1002-2");
    return options.receiptOverride ?? receipt;
  };
  const request: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname;
    requests.push(`${url.origin}${path}`);
    if (url.origin === "https://api.vercel.com") {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.VERCEL_TOKEN}`);
      assert.equal(url.searchParams.get("teamId"), teamId);
      if (path === `/v9/projects/${projectId}`) return Response.json(project);
      if (path === `/v9/projects/${projectId}/domains/${standingPreviewAlias}`) return new Response(null, { status: 404 });
      if (path === `/v10/projects/${projectId}/env`) return Response.json({ envs: [] });
      if (path === `/v3/env/pull/${projectId}/development`) return Response.json({ env: { VERCEL_OIDC_TOKEN: oidc } });
      if (path.startsWith("/v13/deployments/")) {
        const id = path.split("/").at(-1);
        const common = { id, ownerId: teamId, projectId, name: "mille", readyState: "READY" };
        if (id === productionId) return Response.json({ ...common, public: false, target: "production", url: "production.vercel.app",
          gitSource: { sha: options.oldProduction ? pr.headSha : pr.mergeSha, ref: "main", type: "github", repoId: repository.id } });
        if (id === legacy.deploymentId) return Response.json({ ...common, public: false, url: new URL(legacy.origin).hostname });
        if (id === release.id) return Response.json({ ...common, public: false, target: "preview", url: new URL(release.origin).hostname,
          meta: { milleStandingPreviewRepository: repository.full_name, milleStandingPreviewProtocol: receipt.protocol,
            milleStandingPreviewSha: release.sha, milleStandingPreviewEndpointId: database.endpointId,
            milleStandingPreviewDbHostHash: createHash("sha256").update(dbHost).digest("hex") } });
      }
      if (path === "/v6/deployments") {
        assert.equal(url.searchParams.get("projectId"), projectId);
        const next = url.searchParams.get("until") === null ? 10 : null;
        const deployments = next === null && options.activeDeployment
          ? [{ uid: "dpl_Dangling", projectId, gitSource: { ref: pr.headRef } }] : [];
        return Response.json({ deployments, pagination: { count: deployments.length, next } });
      }
      if (path.startsWith("/v4/aliases/")) {
        const aliasHost = path.split("/").at(-1);
        if (aliasHost === standingPreviewAlias) return Response.json({ uid: alias.id, alias: aliasHost, projectId, deploymentId: release.id });
        return Response.json({ uid: "production-alias", alias: aliasHost, projectId, deploymentId: productionId });
      }
    }
    if (url.origin === "https://console.neon.tech") {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.NEON_API_KEY}`);
      const projectPath = `/api/v2/projects/${database.projectId}`;
      const branchPath = `${projectPath}/branches/${database.branchId}`;
      const branch = { id: database.branchId, name: "main", project_id: database.projectId, default: true, protected: false, current_state: "ready" };
      if (path === projectPath) return Response.json({ project: { id: database.projectId, name: "mille-preview", org_id: "org-twilight-grass-67941976" } });
      if (path === branchPath) return Response.json({ branch });
      if (path === `${projectPath}/endpoints` || path === `${branchPath}/endpoints`) return Response.json({ endpoints: [{ id: database.endpointId, host: dbHost,
        project_id: database.projectId, branch_id: database.branchId, type: "read_write", disabled: false }] });
      if (path === `${branchPath}/databases`) return Response.json({ databases: [{ id: 42166654, branch_id: database.branchId, name: "neondb", owner_name: "neondb_owner" }] });
      if (path === `${projectPath}/branches`) {
        if (!url.searchParams.has("cursor")) return Response.json({ branches: [branch], pagination: { next: "page 2" } });
        const branches = options.activeNeonBranch ? [{ ...branch, id: "br-dangling", default: false, name: `preview/${pr.headRef}` }] : [];
        return Response.json({ branches });
      }
    }
    if (url.origin === "https://mille-hazel.vercel.app" && path === "/api/runtime") {
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return Response.json({ app: "mille", sha: pr.mergeSha });
    }
    if (url.origin === fixedOrigin || url.origin === legacy.origin) {
      const supplied = new Headers(init?.headers).get("x-vercel-trusted-oidc-idp-token");
      if (!supplied) return options.unprotected ? Response.json({}) : Response.redirect("https://vercel.com/sso-api");
      assert.equal(supplied, oidc);
      assert.equal(path, "/api/runtime");
      return Response.json({ app: "mille", sha: url.origin === fixedOrigin ? pr.mergeSha : legacy.sha });
    }
    return assert.fail(`未定義の確認ポート ${url.origin}${path}`);
  };
  return { requests, github, inspect: () => readPostMergeEvidence(pr, env, { read, request, download }) };
}

test("マージ SHA と CI、本番、常設の証跡・実行時、cleanup の完了と現在の不在を照合する", async () => {
  const result = await setup().inspect();
  assert.deepEqual(Object.values(result).map(item => item.status), ["passed", "passed", "passed", "passed"]);
  assert.deepEqual(result.ci.status === "passed" && result.ci.details, { runId: 1001, attempt: 3, jobId: 2001 });
  assert.equal(result.standing.status === "passed" && result.standing.details.runtimeSha, pr.mergeSha);
  assert.equal(result.cleanup.status === "passed" && result.cleanup.details.headSha, pr.headSha);
  for (const value of [env.GH_TOKEN, env.VERCEL_TOKEN, env.NEON_API_KEY, oidc]) assert.ok(!JSON.stringify(result).includes(value));
});

test("cleanup の管理ジョブが成功扱いでも明示的な確認工程がスキップされると不在の証拠にならない", async () => {
  const { requests, inspect } = setup({ skippedCleanup: true });
  assert.deepEqual((await inspect()).cleanup, { status: "failed", reason: "run-failed" });
  assert.ok(!requests.includes("https://api.vercel.com/v6/deployments"));
});

test("Vercel と Neon の2ページ目以降に残る PR 専用資源も検出する", async () => {
  for (const flag of ["activeDeployment", "activeNeonBranch"]) {
    assert.deepEqual((await setup({ [flag]: true }).inspect()).cleanup, { status: "failed", reason: "resources-present" });
  }
});

test("別の常設試行の証跡、不保護の URL、および本番伝播待ちを成功扱いしない", async () => {
  const invalid = await setup({ receiptOverride: { ...receipt, runAttempt: "1" } }).inspect();
  assert.deepEqual(invalid.standing, { status: "failed", reason: "receipt-invalid" });
  assert.equal(invalid.production.status, "passed");
  const unprotected = await setup({ unprotected: true }).inspect();
  assert.equal(unprotected.standing.status, "failed");
  const prior = await setup({ oldProduction: true }).inspect();
  assert.deepEqual(prior.production, { status: "pending", reason: "waiting-for-production" });
  assert.equal(prior.cleanup.status, "passed");
});
