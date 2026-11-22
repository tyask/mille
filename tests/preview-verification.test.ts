import assert from "node:assert/strict";
import test from "node:test";
import { allowsFormalPreviewRequest, isVercelToolbarRequest, scopedProtectionHeaders, type BrowserProof } from "../scripts/cloud/verify";
import type { PreviewStatus } from "../scripts/preview/status";
import { readDevelopmentOidc, verifyCurrentPreview } from "../scripts/preview/verify";

const sha = "a".repeat(40);
const control = "b".repeat(40);
const target: PreviewStatus = {
  pr: 21, ref: "codex/test-preview", sha, deploymentId: "dpl_21", origin: "https://mille-test.vercel.app", mode: "legacy",
  database: { branchId: "br-test", endpointId: "ep-test", generation: "br-test" },
};
const caseNames = ["desktop-user-a", "desktop-user-b", "mobile-user-a", "mobile-user-b"];

function browser(): BrowserProof {
  const source = { sha: control, branch: "HEAD", clean: true };
  return {
    protocol: "mille-browser/v1", success: true,
    startedAt: "2026-11-23T00:00:00Z", finishedAt: "2026-11-23T00:00:01Z", durationMs: 1000,
    source: { before: source, after: source, unchanged: true },
    target: { kind: "preview", origin: target.origin, expectedSha: sha, runtimeSha: sha },
    environment: { platform: "linux", node: "24.22.3", chromium: "151" },
    cases: caseNames.map(name => ({
      name, userKey: name.endsWith("a") ? "user-a" : "user-b", mobile: name.startsWith("mobile"),
      status: "passed", checks: ["runtime-sha", "runtime-after"], screenshots: [], durationMs: 100,
    })),
    resources: { browserContexts: 0, browsers: 0, servers: 0, databases: 0, workspaces: 0 },
  };
}

test("正式 Preview は同じデプロイと専用 DB をブラウザ検証の前後で照合する", async () => {
  let reads = 0;
  const result = await verifyCurrentPreview(target.deploymentId, control, async () => {
    reads++;
    return structuredClone(target);
  }, async snapshot => {
    assert.equal(reads, 1);
    assert.deepEqual(snapshot, target);
    return browser();
  });
  assert.equal(reads, 2);
  assert.deepEqual(result.target, target);
  assert.deepEqual(result.browser.cases, caseNames.map(name => ({ name, status: "passed" })));
  assert.equal(result.browser.runtimeSha, sha);
  assert.deepEqual(Object.keys(result.browser), ["cases", "runtimeSha", "finishedAt", "durationMs"]);
});

test("正式 Preview は古いデプロイ、途中の DB 変更、対象違いの証跡を拒否する", async () => {
  await assert.rejects(verifyCurrentPreview("dpl_stale", control, async () => target, () => assert.fail("browser invoked")), /デプロイ/);
  let reads = 0;
  await assert.rejects(verifyCurrentPreview(target.deploymentId, control, async () => {
    if (++reads === 1) return target;
    return { ...target, database: { ...target.database, endpointId: "ep-other" } };
  }, async () => browser()), /変わりました/);
  const invalid = [browser(), browser(), browser(), browser()];
  invalid[0].source.before = { sha, branch: "main", clean: true };
  invalid[1].target.runtimeSha = "c".repeat(40);
  invalid[2].cases[3].name = invalid[2].cases[0].name;
  invalid[3].cases[0].checks.pop();
  for (const result of invalid) {
    await assert.rejects(verifyCurrentPreview(target.deploymentId, control, async () => target, async () => result), /証跡/);
  }
});

test("正式 Preview の通信は同一 origin の OIDC と読み取り・テスト認証に限る", () => {
  const header = "x-vercel-trusted-oidc-idp-token";
  assert.deepEqual(scopedProtectionHeaders(`${target.origin}/api/runtime`, target.origin, "sample", header), { [header]: "sample" });
  assert.deepEqual(scopedProtectionHeaders("https://foreign.vercel.app/api/runtime", target.origin, "sample", header), {});
  assert.equal(allowsFormalPreviewRequest("GET", "/api/workspaces"), true);
  assert.equal(allowsFormalPreviewRequest("POST", "/api/auth/callback/test-login"), true);
  assert.equal(allowsFormalPreviewRequest("POST", "/api/auth/signout"), true);
  for (const path of ["/api/workspaces", "/api/auth/callback/google", "/api/auth/callback/test-login/"]) {
    assert.equal(allowsFormalPreviewRequest("POST", path), false);
  }
  assert.equal(allowsFormalPreviewRequest("DELETE", "/api/workspaces/id"), false);
});

test("既知の Vercel Toolbar スクリプトの GET だけを検証対象外の遮断として識別する", () => {
  const url = "https://vercel.live/_next-live/feedback/feedback.js";
  assert.equal(isVercelToolbarRequest("GET", "script", url), true);
  assert.equal(isVercelToolbarRequest("GET", "Script", url), true);
  assert.equal(isVercelToolbarRequest("POST", "script", url), false);
  assert.equal(isVercelToolbarRequest("GET", "document", url), false);
  for (const invalid of [
    `${url}?extra=1`, `${url}#extra`, url.replace("https://", "https://user@"),
    url.replace("vercel.live", "another.vercel.live"), url.replace("feedback.js", "another.js"),
  ]) {
    assert.equal(isVercelToolbarRequest("GET", "script", invalid), false);
  }
});

test("既存 Vercel 資格情報で GET した短期 OIDC のチーム・プロジェクト・環境・期限を検証する", async () => {
  const env = { VERCEL_TOKEN: "fixture", MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: "prj_Mille", MILLE_PR_PREVIEW_VERCEL_TEAM_ID: "team_Mille" };
  const expected = { owner_id: "team_Mille", project_id: "prj_Mille", environment: "development", exp: Math.floor(Date.now() / 1000) + 300 };
  function jwt(claims: typeof expected) {
    return `header.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.signature`;
  }
  const token = jwt(expected);
  const result = await readDevelopmentOidc(env, async (input, request) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.pathname, "/v3/env/pull/prj_Mille/development");
    assert.equal(url.searchParams.get("teamId"), "team_Mille");
    assert.equal(request?.method, "GET");
    assert.equal(request?.redirect, "error");
    return Response.json({ env: { VERCEL_OIDC_TOKEN: token, OTHER: "fixture" } });
  });
  assert.equal(result, token);
  const mismatches = [{ owner_id: "team_Other" }, { project_id: "prj_Other" }, { environment: "production" }, { exp: 0 }];
  for (const mismatch of mismatches) {
    await assert.rejects(readDevelopmentOidc(env, async () =>
      Response.json({ env: { VERCEL_OIDC_TOKEN: jwt({ ...expected, ...mismatch }) } })), /OIDC/);
  }
});
