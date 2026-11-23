import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserProof } from "../scripts/cloud/verify";
import { checkProtectedRuntime, publishStandingPreview, readStandingMainCi, StandingMainCiPending } from "../scripts/preview/standing";

const sha = "a".repeat(40);
const release = { id: "dpl_Release", sha, origin: "https://mille-release-fumin1.vercel.app" };
const fixed = "https://mille-main-preview-fumin1.vercel.app";
const binding = { uid: "alias_created", alias: "mille-main-preview-fumin1.vercel.app", projectId: "prj_Test", deploymentId: release.id } as const;
const previous = { id: "dpl_Previous", sha: "b".repeat(40), origin: "https://mille-before-fumin1.vercel.app" };
const previousBinding = { ...binding, uid: "alias_previous", deploymentId: previous.id };
const baseline = { productionDeploymentId: "dpl_Production", productionSha: sha, legacyDeploymentId: "dpl_Legacy",
  productionAliases: Object.fromEntries(["mille-hazel.vercel.app", "mille-fumin1.vercel.app", "mille-git-main-fumin1.vercel.app"]
    .map(alias => [alias, "dpl_Production"])) as Record<"mille-hazel.vercel.app" | "mille-fumin1.vercel.app" | "mille-git-main-fumin1.vercel.app", string> };
const db = { projectId: "billowing-cherry-59956184", branchId: "br-dark-rain-a1cc9tfa",
  endpointId: "ep-bitter-wind-a1atj6vn", host: "ep-bitter-wind-a1atj6vn.ap-southeast-1.aws.neon.tech" };

function browserProof(): BrowserProof {
  const source = { sha, clean: true, branch: "main" };
  return {
    protocol: "mille-browser/v1", success: true, startedAt: "2026-11-23T00:00:00Z",
    finishedAt: "2026-11-23T00:01:00Z", durationMs: 60_000,
    source: { before: source, after: source, unchanged: true },
    target: { kind: "preview", origin: release.origin, expectedSha: sha, runtimeSha: sha },
    environment: { platform: "linux", node: "24.22.3", chromium: null },
    resources: { browserContexts: 0, browsers: 0, servers: 0, databases: 0, workspaces: 0 },
    cases: ["desktop-user-a", "desktop-user-b", "mobile-user-a", "mobile-user-b"].map(name => ({
      name, userKey: name.slice(-1), mobile: name.startsWith("mobile"), status: "passed",
      checks: ["runtime-sha", "runtime-after"], screenshots: [], durationMs: 60_000,
    })),
  };
}

function setup({ existing = null, badProof = false, aliasUnprotected = false, changedDatabase = false, failedReadback = false,
  allowFirstAssignment = true, badPreviousSha = false, delayedAlias }: {
    existing?: { uid: string; alias: typeof binding.alias; projectId: string; deploymentId: string } | null;
    badProof?: boolean; aliasUnprotected?: boolean; changedDatabase?: boolean; failedReadback?: boolean;
    allowFirstAssignment?: boolean; badPreviousSha?: boolean; delayedAlias?: "missing" | "previous-sha";
  } = {}) {
  const writes: string[] = [];
  const waits: number[] = [];
  const reports: string[] = [];
  let alias = existing;
  let browsed = false;
  let checkCount = 0;
  const run = () => publishStandingPreview(sha, {
    verifyCurrent: async () => {},
    verifyPriorMain: async prior => {
      assert.equal(prior, previous.sha);
      if (badPreviousSha) throw new Error("旧 SHA は main の祖先でありません");
    },
    vercel: {
      preflight: async () => {},
      readBaseline: async () => baseline,
      readAlias: async () => alias,
      deploy: async (_input, guard) => {
        await guard();
        writes.push("deploy");
        return release;
      },
      readDeployment: async (id, expectedSha) => {
        if (id === previous.id) {
          assert.ok(expectedSha === undefined || expectedSha === previous.sha);
          return previous;
        }
        if (id !== release.id) throw new Error("別デプロイの割り当て");
        return release;
      },
      assignAlias: async (id, guard, onCreated, prior) => {
        await guard();
        assert.equal(id, release.id);
        assert.deepEqual(prior, existing);
        writes.push("assign");
        alias = binding;
        onCreated?.(binding);
        if (failedReadback) throw new Error("割り当ての再取得");
        return binding;
      },
      removeAlias: async (expected, guard) => {
        await guard();
        assert.deepEqual(expected, alias);
        writes.push("remove");
        alias = null;
      },
      restoreAlias: async (expected, old, guard) => {
        await guard();
        assert.deepEqual(expected, alias);
        assert.deepEqual(old, previousBinding);
        writes.push("restore");
        alias = { ...old, uid: "alias_restored" };
        return alias;
      },
    },
    identifyDatabase: async () => changedDatabase && browsed ? { ...db, endpointId: "ep-other" } : db,
    prepareDatabase: async (target, guard, initial) => {
      assert.deepEqual(target, db);
      await guard();
      writes.push(initial ? "migrate" : "database-readback");
      return { mode: "hosted", environment: "preview", environmentId: "mille-preview", host: db.host,
        url: "postgresql://fixture:fixture@localhost/neondb" };
    },
    readSource: async () => [{ file: "package.json", data: Buffer.from("{}") }],
    browse: async target => {
      assert.deepEqual(target, release);
      browsed = true;
      writes.push("browser");
      const proof = browserProof();
      if (badProof) proof.target.runtimeSha = "b".repeat(40);
      return proof;
    },
    checkRuntime: async (origin, runtimeSha, expectedPrior) => {
      if (origin === fixed) {
        if (runtimeSha === previous.sha) {
          assert.equal(alias?.deploymentId, previous.id);
          return;
        }
        assert.equal(runtimeSha, sha);
        assert.equal(alias?.deploymentId, release.id);
        writes.push("fixed");
        if (aliasUnprotected) throw new Error("固定 URL の保護");
        if (delayedAlias && ++checkCount === 1) {
          await checkProtectedRuntime(origin, sha, "short-test-token", async (_url, init) => {
            if (delayedAlias === "missing") return new Response(null, { status: 404, headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" } });
            if (new Headers(init?.headers).has("x-vercel-trusted-oidc-idp-token")) return Response.json({ app: "mille", sha: previous.sha });
            return new Response(null, { status: 302, headers: { Location: "https://vercel.com/sso-api" } });
          }, expectedPrior);
        }
      }
    },
  }, stage => reports.push(stage), { allowFirstAssignment, wait: async duration => { waits.push(duration); } });
  return { writes, reports, waits, run, binding: () => alias };
}

test("正式ブラウザの全ケースと実行時 SHA を確認してから初回の固定 URL を割り当てる", async () => {
  const f = setup();
  const proof = await f.run();
  assert.equal(proof.controlSha, sha);
  assert.equal(proof.browser.cases.length, 4);
  assert.equal(proof.alias.id, binding.uid);
  assert.ok(!JSON.stringify(proof).includes("postgresql"));
  assert.deepEqual(f.writes, ["migrate", "deploy", "browser", "assign", "fixed"]);
});

test("証跡の SHA の不一致、またはブラウザ検証中の DB 変更で固定 URL を割り当てない", async () => {
  for (const options of [{ badProof: true }, { changedDatabase: true }]) {
    const f = setup(options);
    await assert.rejects(f.run, /ブラウザ証跡|照合先が変わりました/);
    assert.deepEqual(f.writes, ["migrate", "deploy", "browser"]);
  }
});

test("公開後の確認失敗で今回作成した割り当てのみを戻す", async () => {
  const failed = setup({ aliasUnprotected: true });
  await assert.rejects(failed.run, /固定 URL の保護/);
  assert.deepEqual(failed.writes, ["migrate", "deploy", "browser", "assign", "fixed", "remove"]);
  assert.ok(failed.reports.includes("restored-alias"));
  assert.equal(failed.binding(), null);
  const readback = setup({ failedReadback: true });
  await assert.rejects(readback.run, /割り当ての再取得/);
  assert.deepEqual(readback.writes, ["migrate", "deploy", "browser", "assign", "remove"]);
  assert.equal(readback.binding(), null);
  const existing = setup({ existing: binding, aliasUnprotected: true });
  await assert.rejects(existing.run, /固定 URL の保護/);
  assert.deepEqual(existing.writes, ["browser", "fixed"]);
  assert.deepEqual(existing.binding(), binding);
});

test("同じ SHA の既存割り当ての再確認を許し、別デプロイへの既存割り当てを保持する", async () => {
  const existing = setup({ existing: binding });
  await existing.run();
  assert.deepEqual(existing.writes, ["browser", "fixed"]);
  const other = setup({ existing: { ...binding, deploymentId: "dpl_Other" } });
  await assert.rejects(other.run, /別デプロイ/);
  assert.deepEqual(other.writes, []);
});

test("main の祖先で保護済みの常設 Preview から、検証を終えた新しい SHA に固定 URL を更新する", async () => {
  for (const delayedAlias of ["missing", "previous-sha"] as const) {
    const f = setup({ existing: previousBinding, allowFirstAssignment: false, delayedAlias });
    const proof = await f.run();
    assert.equal(proof.release.sha, sha);
    assert.equal(proof.alias.id, binding.uid);
    assert.deepEqual(f.waits, [2_000]);
    assert.deepEqual(f.writes, ["database-readback", "deploy", "browser", "assign", "fixed", "fixed"]);
    assert.deepEqual(f.binding(), binding);
  }
});

test("固定 URL が欠落または main の履歴と一致しない場合は自動変更せず、更新後の確認失敗時は旧デプロイを復元する", async () => {
  const missing = setup({ allowFirstAssignment: false });
  await assert.rejects(missing.run, /既存の固定 URL/);
  assert.deepEqual(missing.writes, []);
  const badSource = setup({ existing: previousBinding, badPreviousSha: true });
  await assert.rejects(badSource.run, /main の祖先/);
  assert.deepEqual(badSource.writes, []);
  const failed = setup({ existing: previousBinding, aliasUnprotected: true });
  await assert.rejects(failed.run, /固定 URL の保護/);
  assert.deepEqual(failed.writes, ["database-readback", "deploy", "browser", "assign", "fixed", "restore"]);
  assert.deepEqual(failed.waits, []);
  assert.equal(failed.binding()?.deploymentId, previous.id);
  assert.ok(failed.reports.includes("restored-alias"));
});

test("main CI の最新試行の run・実行 job・checkout 完了を照合する", async () => {
  const repo = { id: 1436928292 };
  const run = { id: 882, run_attempt: 2, head_branch: "main", head_sha: sha, event: "push", status: "completed",
    conclusion: "success", path: ".github/workflows/ci.yml", repository: repo, head_repository: repo };
  const check = { id: 209, run_id: 882, run_attempt: 2, head_sha: sha, name: "check", status: "completed", conclusion: "success",
    steps: [{ name: "照合したソースとテスト対象を記録", status: "completed", conclusion: "success" }] };
  const read = (runs: unknown[], job: unknown = check) => async (path: string) => {
    if (path.startsWith("actions/workflows/ci.yml/runs?")) return { workflow_runs: runs };
    assert.equal(path, "actions/runs/882/attempts/2/jobs");
    return { total_count: 1, jobs: [job] };
  };
  assert.deepEqual(await readStandingMainCi(read([run]), sha), { runId: 882, attempt: 2, jobId: 209 });
  await assert.rejects(readStandingMainCi(read([{ ...run, status: "in_progress", conclusion: null }, run]), sha), StandingMainCiPending);
  await assert.rejects(readStandingMainCi(read([{ ...run, conclusion: "failure" }, run]), sha), /成功していません/);
  await assert.rejects(readStandingMainCi(read([run], { ...check, head_sha: previous.sha }), sha), /checkout/);
  await assert.rejects(readStandingMainCi(read([run], { ...check, steps: [] }), sha), /checkout/);
});

test("固定 URL の protection と実行時 SHA は同一 origin の GET で照合する", async () => {
  const calls: (RequestInit | undefined)[] = [];
  await checkProtectedRuntime(fixed, sha, "short-test-token", async (url, init) => {
    calls.push(init);
    assert.equal(String(url), fixed + (calls.length === 1 ? "/" : "/api/runtime"));
    return calls.length <= 2
      ? new Response(null, { status: 302, headers: { Location: "https://vercel.com/sso-api" } })
      : Response.json({ app: "mille", sha });
  });
  assert.equal(new Headers(calls[0]?.headers).has("x-vercel-trusted-oidc-idp-token"), false);
  assert.equal(new Headers(calls[1]?.headers).has("x-vercel-trusted-oidc-idp-token"), false);
  assert.equal(new Headers(calls[2]?.headers).get("x-vercel-trusted-oidc-idp-token"), "short-test-token");
  assert.equal(calls[2]?.redirect, "error");
  for (const response of [Response.json({ app: "mille", sha }),
    new Response(null, { status: 302, headers: { Location: "https://another.vercel.app/sso-api" } })]) {
    let attempts = 0;
    await assert.rejects(checkProtectedRuntime(fixed, sha, "short-test-token", async () => {
      attempts++;
      return response;
    }), /未認証アクセス/);
    assert.equal(attempts, 2);
  }
});
