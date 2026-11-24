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
const files = [{ file: "package.json", data: Buffer.from("{}") },
  { file: "db/migrations/007_fixture.sql", data: Buffer.from("SELECT 7;\n") }];
const previousFiles = [{ file: "package.json", data: Buffer.from("{}") }];
const configuration = { mode: "hosted", environment: "preview", environmentId: "mille-preview", host: db.host,
  url: "postgresql://fixture:fixture@localhost/neondb" } as const;

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
  allowFirstAssignment = true, badPreviousSha = false, delayedAlias, failAt }: {
    existing?: { uid: string; alias: typeof binding.alias; projectId: string; deploymentId: string } | null;
    badProof?: boolean; aliasUnprotected?: boolean; changedDatabase?: boolean; failedReadback?: boolean;
    allowFirstAssignment?: boolean; badPreviousSha?: boolean; delayedAlias?: "missing" | "previous-sha";
    failAt?: "previous-source" | "open" | "build" | "staged-readback" | "staged-ref-drift" | "migrate" | "before-browser" | "before-publish";
  } = {}) {
  const writes: string[] = [];
  const waits: number[] = [];
  const reports: string[] = [];
  const historyChecks: string[] = [];
  const migrationReports: string[][] = [];
  const previousSourceReads: string[] = [];
  const previousRuntimeChecks = new Set<string>();
  let alias = existing;
  let previousMainVerified = false;
  let opened = false;
  let deployed = false;
  let stagedReadback = false;
  let browsed = false;
  let checkCount = 0;
  const run = () => publishStandingPreview(sha, {
    verifyCurrent: async () => {
      if (stagedReadback && failAt === "staged-ref-drift") throw new Error("main が変わりました");
    },
    verifyPriorMain: async prior => {
      assert.equal(prior, previous.sha);
      if (badPreviousSha) throw new Error("旧 SHA は main の祖先でありません");
      previousMainVerified = true;
    },
    vercel: {
      preflight: async () => {},
      readBaseline: async () => baseline,
      readAlias: async () => alias,
      deploy: async (input, guard) => {
        await guard();
        assert.equal(opened, true);
        assert.deepEqual(input, { sha, database: configuration, endpointId: db.endpointId, files });
        writes.push("deploy");
        if (failAt === "build") throw new Error("Vercel ビルド失敗");
        deployed = true;
        return release;
      },
      readDeployment: async (id, expectedSha, endpointId) => {
        assert.equal(endpointId, db.endpointId);
        if (id === previous.id) {
          assert.ok(expectedSha === undefined || expectedSha === previous.sha);
          return previous;
        }
        if (id !== release.id) throw new Error("別デプロイの割り当て");
        assert.ok(expectedSha === undefined || expectedSha === sha);
        if (deployed && !browsed) {
          assert.equal(expectedSha, sha);
          if (failAt === "staged-readback") return { ...release, sha: previous.sha };
          stagedReadback = true;
        }
        return release;
      },
      assignAlias: async (id, guard, onCreated, prior) => {
        await guard();
        assert.ok(historyChecks.includes("before-publish"));
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
    openDatabase: async (target, sources, priorSources) => {
      assert.deepEqual(target, db);
      assert.deepEqual(sources, files);
      if (existing?.deploymentId === previous.id) {
        assert.deepEqual(previousSourceReads, [previous.sha]);
        assert.deepEqual(priorSources, previousFiles);
      } else {
        assert.deepEqual(previousSourceReads, []);
        assert.equal(priorSources, existing?.deploymentId === release.id ? sources : undefined);
      }
      if (failAt === "open") throw new Error("常設 DB の事前照合失敗");
      opened = true;
      return {
        configuration,
        migrate: async guard => {
          await guard();
          assert.equal(stagedReadback, true);
          writes.push("migrate");
          if (failAt === "migrate") throw new Error("常設 DB の移行失敗");
          return ["007_fixture.sql"];
        },
        verify: async () => {
          const stage = browsed ? "before-publish" : "before-browser";
          historyChecks.push(stage);
          if (failAt === stage) throw new Error("常設 DB の移行履歴不一致");
        },
      };
    },
    readSource: async () => files,
    readPreviousSource: async prior => {
      assert.equal(prior, previous.sha);
      assert.equal(previousMainVerified, true);
      assert.ok(previousRuntimeChecks.has(previous.origin) && previousRuntimeChecks.has(fixed));
      assert.equal(opened, false);
      previousSourceReads.push(prior);
      if (failAt === "previous-source") throw new Error("旧デプロイのソース照合失敗");
      return previousFiles;
    },
    browse: async target => {
      assert.deepEqual(target, release);
      assert.ok(historyChecks.includes("before-browser"));
      browsed = true;
      writes.push("browser");
      const proof = browserProof();
      if (badProof) proof.target.runtimeSha = "b".repeat(40);
      return proof;
    },
    checkRuntime: async (origin, runtimeSha, expectedPrior) => {
      if (runtimeSha === previous.sha) previousRuntimeChecks.add(origin);
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
  }, stage => reports.push(stage), {
    allowFirstAssignment,
    wait: async duration => { waits.push(duration); },
    onMigrationsApplied: names => { migrationReports.push([...names]); },
  });
  return { writes, reports, waits, historyChecks, migrationReports, previousSourceReads, run, binding: () => alias };
}

test("ビルドとデプロイ照合後に移行し、履歴・正式ブラウザを確認して固定 URL を割り当てる", async () => {
  const f = setup();
  const proof = await f.run();
  assert.equal(proof.controlSha, sha);
  assert.equal(proof.browser.cases.length, 4);
  assert.equal(proof.alias.id, binding.uid);
  assert.ok(!JSON.stringify(proof).includes("postgresql"));
  assert.deepEqual(f.writes, ["deploy", "migrate", "browser", "assign", "fixed"]);
  assert.deepEqual(f.historyChecks, ["before-browser", "before-publish"]);
  assert.deepEqual(f.migrationReports, [["007_fixture.sql"]]);
});

test("旧ソース、ビルド、デプロイ、移行、履歴の照合に失敗すると既存の固定 URL を保持する", async () => {
  const failures = [
    { failAt: "previous-source", error: /旧デプロイのソース照合失敗/, writes: [] },
    { failAt: "open", error: /事前照合失敗/, writes: [] },
    { failAt: "build", error: /ビルド失敗/, writes: ["deploy"] },
    { failAt: "staged-readback", error: /デプロイが変わりました/, writes: ["deploy"] },
    { failAt: "staged-ref-drift", error: /main が変わりました/, writes: ["deploy"] },
    { failAt: "migrate", error: /DB の移行失敗/, writes: ["deploy", "migrate"] },
    { failAt: "before-browser", error: /移行履歴不一致/, writes: ["deploy", "migrate"] },
    { failAt: "before-publish", error: /移行履歴不一致/, writes: ["deploy", "migrate", "browser"] },
  ] as const;
  for (const { failAt, error, writes } of failures) {
    const f = setup({ existing: previousBinding, failAt });
    await assert.rejects(f.run, error);
    assert.deepEqual(f.writes, writes, failAt);
    assert.deepEqual(f.binding(), previousBinding, failAt);
  }
});

test("証跡の SHA の不一致、またはブラウザ検証中の DB 変更で既存の固定 URL を保持する", async () => {
  for (const options of [{ badProof: true }, { changedDatabase: true }]) {
    const f = setup({ ...options, existing: previousBinding });
    await assert.rejects(f.run, /ブラウザ証跡|照合先が変わりました/);
    assert.deepEqual(f.writes, ["deploy", "migrate", "browser"]);
    assert.deepEqual(f.binding(), previousBinding);
  }
});

test("公開後の確認失敗で今回作成した割り当てのみを戻す", async () => {
  const failed = setup({ aliasUnprotected: true });
  await assert.rejects(failed.run, /固定 URL の保護/);
  assert.deepEqual(failed.writes, ["deploy", "migrate", "browser", "assign", "fixed", "remove"]);
  assert.ok(failed.reports.includes("restored-alias"));
  assert.equal(failed.binding(), null);
  const readback = setup({ failedReadback: true });
  await assert.rejects(readback.run, /割り当ての再取得/);
  assert.deepEqual(readback.writes, ["deploy", "migrate", "browser", "assign", "remove"]);
  assert.equal(readback.binding(), null);
  const existing = setup({ existing: binding, aliasUnprotected: true });
  await assert.rejects(existing.run, /固定 URL の保護/);
  assert.deepEqual(existing.writes, ["browser", "fixed"]);
  assert.deepEqual(existing.binding(), binding);
});

test("同じ SHA の既存割り当ては履歴を再確認し、移行とデプロイを繰り返さない", async () => {
  const existing = setup({ existing: binding });
  await existing.run();
  assert.deepEqual(existing.writes, ["browser", "fixed"]);
  assert.deepEqual(existing.historyChecks, ["before-browser", "before-publish"]);
  assert.deepEqual(existing.migrationReports, [[]]);
  assert.deepEqual(existing.previousSourceReads, []);
  const incomplete = setup({ existing: binding, failAt: "before-browser" });
  await assert.rejects(incomplete.run, /移行履歴不一致/);
  assert.deepEqual(incomplete.writes, []);
  assert.deepEqual(incomplete.binding(), binding);
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
    assert.deepEqual(f.writes, ["deploy", "migrate", "browser", "assign", "fixed", "fixed"]);
    assert.deepEqual(f.previousSourceReads, [previous.sha]);
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
  assert.deepEqual(badSource.previousSourceReads, []);
  const failed = setup({ existing: previousBinding, aliasUnprotected: true });
  await assert.rejects(failed.run, /固定 URL の保護/);
  assert.deepEqual(failed.writes, ["deploy", "migrate", "browser", "assign", "fixed", "restore"]);
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
