import assert from "node:assert/strict";
import test from "node:test";
import { planDeploymentRetention } from "../scripts/preview/deployment-retention";

const main = "a".repeat(40);
const older = "b".repeat(40);
const config = {
  controlSha: main, ancestors: new Set([main, older]), teamId: "team_Mille", projectId: "prj_Mille", token: "fixture-token",
};
const repoId = 1436928292;
const standingId = "dpl_PzqN4fUewyF6MtViekWrhWSb5juw";
const standingUrl = "mille-hypzm5ss8-fumin1.vercel.app";
const secret = "provider-body-must-not-leak";

function record(id: string, created: number, options: { state?: string; target?: string | null; ref?: string; source?: string } = {}) {
  const { state = "READY", target = "production", ref = "main", source = older } = options;
  const meta = {
    githubCommitOrg: "tyask", githubCommitRepo: "mille", githubRepoId: String(repoId),
    githubCommitRef: ref, githubCommitSha: source,
  };
  return { uid: id, projectId: config.projectId, created, state, target, meta };
}
const rows = [
  record("dpl_Current", 120, { source: main }), record("dpl_Newest", 140),
  record("dpl_Cron", 100), record("dpl_Target", 90), record("dpl_Alias", 80), record("dpl_DeploymentAlias", 75),
  record("dpl_Old", 70), record("dpl_Error", 60, { state: "ERROR" }), record("dpl_Canceled", 50, { state: "CANCELED" }),
  record("dpl_Building", 160, { state: "BUILDING" }), record("dpl_UnknownState", 170, { state: "UNKNOWN" }),
  record("dpl_OtherRef", 30, { ref: "codex/other" }), record("dpl_UnknownSHA", 25, { source: "f".repeat(40) }),
  { ...record("dpl_PR", 20), meta: { ...record("dpl_PR", 20).meta, millePreviewPr: "60" } },
  record("dpl_Preview", 10, { target: null }), record(standingId, 5, { target: null, ref: "codex/workspaces" }),
];
const targets = { production: { id: "dpl_Current" }, custom: { id: "dpl_Target" } };
const aliases = [
  { alias: "mille.example.invalid", projectId: config.projectId, deploymentId: "dpl_Alias", deployment: { id: "dpl_Alias" } },
];

function fixture(options: {
  mainRead?: (count: number) => string;
  project?: (count: number) => Record<string, unknown>;
  deploymentPages?: (count: number, until: string | null) => unknown;
  projectAliases?: (count: number, until: string | null) => unknown;
  details?: (id: string) => Record<string, unknown>;
  live?: (id: string, count: number) => unknown;
  failPath?: string;
} = {}) {
  const paths: string[] = [];
  let mainCount = 0;
  let projectCount = 0;
  let deploymentsCount = 0;
  let aliasesCount = 0;
  const deploymentAliasCounts = new Map<string, number>();
  const readMain = async () => options.mainRead?.(++mainCount) ?? main;
  const page = <T>(items: T[], next: number | null = null) => ({ pagination: { count: items.length, next } });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input as URL);
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), config.teamId);
    assert.deepEqual([init?.method, init?.redirect, init?.body], ["GET", "error", undefined]);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${config.token}`);
    paths.push(url.pathname);
    if (url.pathname === options.failPath) return new Response(secret, { status: 403 });
    if (url.pathname === `/v9/projects/${config.projectId}`) {
      return Response.json({
        id: config.projectId, accountId: config.teamId, name: "mille",
        link: { type: "github", repoId, org: "tyask", repo: "mille", productionBranch: "main" },
        targets, crons: { deploymentId: "dpl_Cron" }, ...options.project?.(++projectCount),
      });
    }
    if (url.pathname === "/v6/deployments") {
      assert.equal(url.searchParams.get("projectId"), config.projectId);
      assert.equal(url.searchParams.get("limit"), "100");
      return Response.json(options.deploymentPages?.(++deploymentsCount, url.searchParams.get("until")) ?? { deployments: rows, ...page(rows) });
    }
    if (url.pathname === "/v4/aliases") {
      assert.equal(url.searchParams.get("projectId"), config.projectId);
      assert.equal(url.searchParams.get("limit"), "100");
      return Response.json(options.projectAliases?.(++aliasesCount, url.searchParams.get("until")) ?? { aliases, ...page(aliases) });
    }
    const detail = /^\/v13\/deployments\/(dpl_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (detail) {
      assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
      const id = detail[1];
      const row = rows.find(value => value.uid === id);
      assert.ok(row);
      return Response.json({
        id, ownerId: config.teamId, projectId: config.projectId, name: "mille",
        url: id === standingId ? standingUrl : "fixture.example.invalid",
        createdAt: row.created, readyState: row.state, target: row.target, meta: row.meta,
        gitSource: { type: "github", repoId, ref: row.meta.githubCommitRef, sha: row.meta.githubCommitSha },
        ...options.details?.(id),
      });
    }
    const list = /^\/v2\/deployments\/(dpl_[A-Za-z0-9]+)\/aliases$/.exec(url.pathname);
    if (list) {
      assert.deepEqual([...url.searchParams.keys()], ["teamId"]);
      const id = list[1];
      const count = (deploymentAliasCounts.get(id) ?? 0) + 1;
      deploymentAliasCounts.set(id, count);
      return Response.json(options.live?.(id, count) ?? {
        aliases: id === "dpl_DeploymentAlias" ? [{ alias: "other.example.invalid" }] : [],
      });
    }
    throw new Error("Unexpected request");
  };
  return { plan: () => planDeploymentRetention(config, { readMain, request }), paths };
}

test("本番の所有を実情報で照合し、現用参照と最新 READY と既存常設 Preview を保護する", async () => {
  const { plan, paths } = fixture();
  assert.deepEqual(await plan(), {
    controlSha: main, productionDeploymentId: "dpl_Current", standingDeploymentId: standingId,
    newestReadyDeploymentId: "dpl_Newest", scanned: rows.length,
    candidates: [
      { id: "dpl_Old", sha: older, state: "READY" },
      { id: "dpl_Error", sha: older, state: "ERROR" },
      { id: "dpl_Canceled", sha: older, state: "CANCELED" },
    ],
  });
  for (const id of ["dpl_Current", "dpl_Newest", "dpl_Cron", "dpl_Target", "dpl_Alias"]) {
    assert.ok(!paths.includes(`/v2/deployments/${id}/aliases`));
  }
  for (const id of ["dpl_PR", "dpl_Building", "dpl_UnknownState", "dpl_OtherRef", "dpl_Preview", "dpl_UnknownSHA"]) {
    assert.ok(!paths.includes(`/v13/deployments/${id}`));
  }
});

test("デプロイと全プロジェクトエイリアスの全ページを照合する", async () => {
  const aliasFirstPage = [{ ...aliases[0], alias: "legacy.example.invalid", deploymentId: "dpl_Target", deployment: { id: "dpl_Target" } }];
  const { plan, paths } = fixture({
    deploymentPages: (_, until) => ({
      deployments: until ? rows.slice(5) : rows.slice(0, 5),
      pagination: { count: until ? rows.length - 5 : 5, next: until ? null : 100 },
    }),
    projectAliases: (_, until) => ({
      aliases: until ? aliases : aliasFirstPage, pagination: { count: 1, next: until ? null : 100 },
    }),
  });
  assert.deepEqual((await plan()).candidates.map(item => item.id), ["dpl_Old", "dpl_Error", "dpl_Canceled"]);
  assert.equal(paths.filter(path => path === "/v6/deployments").length, 4);
  assert.equal(paths.filter(path => path === "/v4/aliases").length, 4);
});

test("ページの欠落・循環・重複と別プロジェクトのエイリアスで停止する", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { deploymentPages: () => ({ deployments: rows, pagination: { count: rows.length + 1, next: null } }) },
    { deploymentPages: (_, until) => ({ deployments: until ? [] : rows, pagination: { count: until ? 0 : rows.length, next: 100 } }) },
    { projectAliases: () => ({ aliases: [aliases[0], { ...aliases[0], alias: aliases[0].alias.toUpperCase() }],
      pagination: { count: 2, next: null } }) },
    { projectAliases: () => ({ aliases: [{ ...aliases[0], projectId: "prj_Other" }], pagination: { count: 1, next: null } }) },
    { projectAliases: () => ({ aliases: [{ ...aliases[0], deployment: { id: "dpl_Other" } }], pagination: { count: 1, next: null } }) },
  ];
  for (const options of cases) await assert.rejects(fixture(options).plan, /一覧|エイリアス/);
});

test("保護する常設・本番、デプロイ所有、Git ソース、個別エイリアスが一致しなければ候補を返さない", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { project: () => ({ targets: { production: { id: "dpl_Other" } } }) },
    { project: () => ({ targets: { production: { id: "dpl_OtherRef" } } }) },
    { details: id => id === standingId ? { url: "foreign.example.invalid" } : {} },
    { details: id => id === "dpl_Old" ? { ownerId: "team_Other" } : {} },
    { details: id => id === "dpl_Old" ? { readyState: "BUILDING" } : {} },
    { details: id => id === "dpl_Old" ? { gitSource: { type: "github", repoId, ref: "main", sha: main } } : {} },
    { live: () => ({ aliases: [], pagination: { count: 1, next: null } }) },
  ];
  for (const options of cases) await assert.rejects(fixture(options).plan, /照合|一致|一覧|所有または状態/);
});

test("古い main は API 取得前に拒否し、実行中の main と参照先の変化も検出する", async () => {
  const stale = fixture({ mainRead: () => older });
  await assert.rejects(stale.plan, /main/);
  assert.deepEqual(stale.paths, []);
  await assert.rejects(fixture({ mainRead: count => count === 1 ? main : older }).plan, /main/);
  await assert.rejects(fixture({ project: count => count === 1 ? {} : { crons: { deploymentId: "dpl_Old" } } }).plan, /照合中/);
  await assert.rejects(fixture({
    projectAliases: count => ({
      aliases: count === 1 ? aliases : [{ ...aliases[0], deploymentId: "dpl_Old", deployment: { id: "dpl_Old" } }],
      pagination: { count: 1, next: null },
    }),
  }).plan, /照合中/);
});

test("個別エイリアスを全件読み、候補への照合中の追加を検出する", async () => {
  const populated = fixture({
    live: id => id === "dpl_Old" ? { aliases: Array.from({ length: 100 }, (_, index) => ({ alias: `alias-${index}.example.invalid` })) } : undefined,
  });
  assert.ok(!(await populated.plan()).candidates.some(candidate => candidate.id === "dpl_Old"));
  const changed = fixture({
    live: (id, count) => id === "dpl_Old" && count === 2 ? { aliases: [{ alias: "added.example.invalid" }] } : undefined,
  });
  await assert.rejects(changed.plan, /エイリアスが照合中に変わりました/);
});

test("API エラーの HTTP 状態を残し、応答本文と資格情報を出さない", async () => {
  await assert.rejects(fixture({ failPath: "/v4/aliases" }).plan, (error: Error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, new RegExp(`${secret}|${config.token}`));
    return true;
  });
});
