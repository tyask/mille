import assert from "node:assert/strict";
import test from "node:test";
import { nativePilotProviders } from "../scripts/preview/native-pilot";
import { NativePilotVercel } from "../scripts/preview/native-pilot-vercel";

const config = {
  token: "fixture-management-token", teamId: "team_Mille", projectId: "prj_Mille", storeId: "store_Mille",
  storeToken: "fixture-store-token",
  neonProjectId: "mille-fixture-project", integrationId: "icfg_Mille", productId: "iap_Mille",
};
const storePath = `/v1/storage/stores/${config.storeId}`;
const repoId = 1436928292;
const target = { pr: 17, ref: "codex/native-preview-pilot-a", sha: "a".repeat(40) };
const generation = "b6ec6368-a4b9-47a5-99d0-7d15014fe50e";
const id = "dpl_Pilot";
const aliasHost = "mille-git-codex-native-preview-pilot-a-fumin1.vercel.app";
const attachedAlias = { alias: aliasHost, projectId: config.projectId, deploymentId: id, redirect: null };
const digest = "d".repeat(64);
const routes = [{ headers: { "X-Mille-Native-Endpoint-SHA256": digest } }];
const secret = "sensitive-fixture-must-never-appear";
const variable = "MILLE_NATIVE_PREVIEW_DATABASE_URL";
const project = {
  id: config.projectId, name: "mille", accountId: config.teamId,
  link: { type: "github", repoId, productionBranch: "main" }, framework: "nextjs", nodeVersion: "24.x",
  autoExposeSystemEnvs: true, ssoProtection: { deploymentType: "all_except_custom_domains" },
};
const connection = {
  projectId: config.projectId, environments: ["preview"], envVarPrefix: "MILLE_NATIVE_PREVIEW_", environmentVariables: [variable],
  deployments: { actions: [{ slug: "branch", environments: ["preview"] }] },
};
const store = {
  id: config.storeId, name: "mille-preview", ownerId: config.teamId, externalResourceId: config.neonProjectId,
  type: "integration", status: "available", totalConnectedProjects: 1, billingPlan: { id: "free_v3" },
  product: { id: config.productId, slug: "neon", integrationConfigurationId: config.integrationId }, projectsMetadata: [connection],
};
const nativeEnv = {
  key: variable, target: ["preview"], configurationId: config.integrationId,
  contentHint: {
    type: "integration-store-secret", integrationConfigurationId: config.integrationId,
    integrationProductId: config.productId, storeId: config.storeId,
  },
  value: secret,
};
const source = { type: "github", repoId, ref: target.ref, sha: target.sha };
const metadata = {
  milleNativePilotProtocol: "mille-native-preview-pilot/v1", milleNativePilotRepository: "tyask/mille",
  milleNativePilotPhase: "provision", milleNativePilotPr: String(target.pr), milleNativePilotRef: target.ref,
  milleNativePilotSha: target.sha, milleNativePilotGeneration: generation, milleNativePilotRequestedAt: "20000",
};
const deployment = {
  id, ownerId: config.teamId, projectId: config.projectId, name: "mille", target: null, public: false, alias: [],
  url: "mille-pilot-fumin1.vercel.app", createdAt: 20001, ready: 21000, readyState: "READY", meta: metadata, gitSource: source, routes,
};
const artifact = { type: "file", path: "index.html" };
const build = { deploymentId: id, readyState: "READY", output: [artifact] };
type ListEntry = { uid: string; projectId: string; meta?: object; gitSource?: object };
type Input = Record<string, unknown>;

function scenario(options: {
  project?: Input; store?: Input; storeFailure?: Response | Error; envs?: readonly unknown[]; deployment?: Input | null;
  details?: (requestNumber: number) => Input; inventory?: (cursor: string | null) => { deployments: ListEntry[]; pagination: { count: number; next: number | null } };
  outputs?: unknown; aliases?: unknown[]; directAlias?: Input; deletePersists?: boolean; aliasPersists?: boolean; rejectPost?: boolean;
} = {}) {
  const requests: string[] = [];
  const writes: Input[] = [];
  let existing = options.deployment === null ? null : { ...deployment, ...options.deployment };
  let directAlias = options.directAlias;
  let detailsRead = 0;
  let waits = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method;
    requests.push(`${method} ${url.pathname}`);
    assert.equal(url.origin, "https://api.vercel.com");
    assert.deepEqual(url.searchParams.getAll("teamId"), [config.teamId]);
    const token = url.pathname === storePath ? config.storeToken : config.token;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(init?.redirect, "error");
    if (method === "POST") assert.equal(url.pathname, "/v13/deployments");
    else if (method === "DELETE") assert.equal(url.pathname, `/v13/deployments/${id}`);
    else assert.equal(method, "GET");
    if (method !== "POST") assert.equal(init?.body ?? null, null);
    switch (url.pathname) {
      case `/v9/projects/${config.projectId}`: return Response.json({ ...project, ...options.project });
      case storePath:
        assert.equal(method, "GET");
        assert.deepEqual([...url.searchParams], [["teamId", config.teamId]]);
        if (options.storeFailure instanceof Error) throw options.storeFailure;
        return options.storeFailure ?? Response.json({ store: { ...store, ...options.store } });
      case `/v10/projects/${config.projectId}/env`:
        assert.equal(url.searchParams.get("decrypt"), "false");
        return Response.json({ envs: options.envs ?? [nativeEnv] });
      case "/v6/deployments": {
        assert.equal(url.searchParams.get("projectId"), config.projectId);
        assert.equal(url.searchParams.get("limit"), "100");
        const items = existing ? [{ uid: id, projectId: config.projectId, meta: existing.meta }] : [];
        return Response.json(options.inventory?.(url.searchParams.get("until"))
          ?? { deployments: items, pagination: { count: items.length, next: null } });
      }
      case "/v13/deployments": {
        assert.equal(method, "POST");
        assert.equal(url.searchParams.get("forceNew"), "1");
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        const requestedAt = Number(body.meta.milleNativePilotRequestedAt);
        existing = { ...deployment, createdAt: requestedAt + 1, ready: requestedAt + 2, meta: body.meta };
        return options.rejectPost ? Response.json({ message: secret }, { status: 500 }) : Response.json({ id });
      }
      case `/v13/deployments/${id}`:
        if (method === "DELETE") {
          if (!options.deletePersists) existing = null;
          if (!options.aliasPersists) directAlias = undefined;
          return new Response(null, { status: 204 });
        }
        assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
        return existing ? Response.json({ ...existing, ...options.details?.(++detailsRead) }) : new Response(null, { status: 404 });
      case `/v2/deployments/${id}/aliases`: return Response.json({ aliases: options.aliases ?? [] });
      case `/v4/aliases/${aliasHost}`: return directAlias ? Response.json(directAlias) : new Response(null, { status: 404 });
      case `/v11/deployments/${id}/builds`:
        return Response.json(options.outputs ?? { builds: [build] });
      default: assert.fail("未定義の Vercel API リクエストです。");
    }
  };
  return { client: new NativePilotVercel(config, request, async () => { waits++; }), requests, writes, waits: () => waits };
}

const current = async () => {};

function assertSafeError(error: unknown) {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /fixture-management-token|fixture-store-token|sensitive-fixture/);
  return true;
}

test("指定ストアの Preview 専用変数と分離した常設変数を復号なしで検証する", async () => {
  const standing = { key: "DATABASE_URL", target: ["preview"], gitBranch: "mille-standing-preview", value: secret };
  const { client, requests } = scenario({ envs: [standing, nativeEnv, { key: "AUTH_SECRET", target: ["production"] }] });
  await client.preflight();
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.startsWith("GET ")));
  await scenario({ store: { projectsMetadata: [{ ...connection, envVarPrefix: "MILLE_NATIVE_PREVIEW" }] } }).client.preflight();
});

test("誤った連携、追加のスコープ、共有設定、追加接続、保護の解除を拒否する", async () => {
  for (const options of [
    { store: { externalResourceId: "other-project" } },
    { store: { projectsMetadata: [connection, connection] } },
    { store: { projectsMetadata: [{ ...connection, environments: ["production", "preview"] }] } },
    { store: { projectsMetadata: [{ ...connection, envVarPrefix: "" }] } },
    { store: { projectsMetadata: [{ ...connection, environmentVariables: [variable, "MILLE_NATIVE_PREVIEW_NEON_AUTH_BASE_URL"] }] } },
    { store: { projectsMetadata: [{ ...connection, deployments: { actions: [] } }] } },
    { envs: [{ key: variable, target: ["preview"] }] },
    { envs: [nativeEnv, { key: "DATABASE_URL", target: ["preview"], gitBranch: target.ref }] },
    { envs: [{ ...nativeEnv, target: ["production", "preview"] }] },
    { project: { env: [{ key: "DATABASE_URL", target: ["preview"] }] } },
    { project: { connectBuildsEnabled: true } },
    { project: { integrations: [{ id: "other" }] } },
    { project: { ssoProtection: null } },
    { project: { protectionBypass: { [secret]: true } } },
    { project: { link: { ...project.link, repoId: 1 } } },
    { project: { buildCommand: "npm run build" } },
  ]) {
    const { client, writes } = scenario({ deployment: null, ...options });
    await assert.rejects(client.provision(target, generation, current), (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.deepEqual(writes, []);
  }
});

test("ストア専用の資格情報がなければ通信前に拒否する", () => {
  const request: typeof fetch = async () => assert.fail("ストア専用の資格情報がない状態で通信しました。");
  for (const storeToken of [undefined, "", config.token]) {
    assert.throws(() => new NativePilotVercel({ ...config, storeToken } as typeof config, request), assertSafeError);
  }
});

test("Neon にストアの資格情報を設定した Native 試験を拒否する", () => {
  const env = {
    NODE_ENV: "test" as const,
    VERCEL_NATIVE_PREVIEW_STORE_TOKEN: config.storeToken,
    NEON_API_KEY: "fixture-neon-token",
    MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID: config.storeId,
    MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID: config.integrationId,
    MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID: config.productId,
    MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: "br-fixture-standing",
    MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: "ep-fixture-standing",
  };
  assert.doesNotThrow(() => nativePilotProviders(env, config));
  assert.throws(() => nativePilotProviders({ ...env, NEON_API_KEY: config.storeToken }, config), assertSafeError);
});

test("ストアの取得拒否や通信失敗でデプロイの作成前に停止する", async () => {
  for (const storeFailure of [
    Response.json({ message: config.storeToken }, { status: 403 }),
    Response.json({ message: config.storeToken }, { status: 404 }),
    new Error(config.storeToken),
  ]) {
    const { client, requests, writes } = scenario({ storeFailure, deployment: null });
    await assert.rejects(client.provision(target, generation, current), assertSafeError);
    assert.equal(requests.filter(request => request === `GET ${storePath}`).length, 1);
    assert.ok(requests.every(request => request.startsWith("GET ")));
    assert.deepEqual(writes, []);
  }
});

test("確認済みの Git ソースと準備用環境変数だけで Preview を作成する", async () => {
  const { client, writes } = scenario({ deployment: null });
  let verified = 0;
  const result = await client.provision(target, generation, async () => { verified++; });
  assert.equal(verified, 2);
  assert.equal(writes.length, 1);
  const { meta, env, ...body } = writes[0];
  assert.deepEqual(body, { project: config.projectId, name: "mille", gitSource: source, public: false, build: { env } });
  assert.deepEqual(env, {
    AUTH_MODE: "test", MILLE_NATIVE_PREVIEW_PHASE: "provision", MILLE_NATIVE_PREVIEW_PR: "17",
    MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: target.ref, MILLE_NATIVE_PREVIEW_SOURCE_SHA: target.sha,
    MILLE_NATIVE_PREVIEW_GENERATION: generation, MILLE_NATIVE_PREVIEW_ATTEST_ENDPOINT: "1",
  });
  assert.deepEqual(meta, { ...metadata, milleNativePilotRequestedAt: String(result.requestedAt) });
  assert.equal(result.url, `https://${deployment.url}`);
  assert.ok(result.createdAt >= result.requestedAt);
  assert.equal(result.readyAt, result.createdAt + 1);
  assert.equal(result.endpointDigest, digest);
  assert.doesNotMatch(JSON.stringify(writes), /fixture-management-token|fixture-store-token|sensitive-fixture/);
});

test("作成時の状態変更や不明な POST 結果を停止し、再試行で二重作成しない", async () => {
  const stopped = scenario({ deployment: null });
  await assert.rejects(stopped.client.provision(target, generation, async () => { throw new Error("PR 更新"); }), /PR 更新/);
  assert.equal(stopped.writes.length, 0);
  const uncertain = scenario({ deployment: null, rejectPost: true });
  await assert.rejects(uncertain.client.provision(target, generation, current), /HTTP 500/);
  assert.equal((await uncertain.client.find(target))?.generation, generation);
  await assert.rejects(uncertain.client.provision(target, generation, current), /作成済み/);
  assert.equal(uncertain.writes.length, 1);
});

test("一覧を全ページ調べ、同じ ref の別 Deployment と不完全なページを拒否する", async () => {
  const own = { uid: id, projectId: config.projectId, meta: metadata };
  const unrelated = { uid: "dpl_Standing", projectId: config.projectId, meta: { githubCommitRef: "main" } };
  const pages = (cursor: string | null) => cursor === null
    ? { deployments: [unrelated], pagination: { count: 1, next: 100 } }
    : { deployments: [own], pagination: { count: 1, next: null } };
  assert.equal((await scenario({ inventory: pages }).client.find(target))?.id, id);
  for (const options of [
    { deployment: { meta: { githubCommitRef: target.ref } }, inventory: () => ({ deployments: [{ ...own, meta: { githubCommitRef: target.ref } }], pagination: { count: 1, next: null } }) },
    { inventory: () => ({ deployments: [own], pagination: { count: 1, next: 25 } }) },
    { inventory: () => ({ deployments: [own], pagination: { count: 2, next: null } }) },
    { deployment: { target: "production" } }, { deployment: { public: true } }, { aliases: [{ alias: "mille-fumin1.vercel.app" }] },
    { deployment: { gitSource: { ...source, repoId: 42 } } }, { deployment: { gitSource: { ...source, ref: "codex/other" } } },
    { deployment: { createdAt: 19000 } }, { deployment: { ready: null } }, { deployment: { ready: 20000 } },
    { deployment: { routes: [routes[0], { headers: { "x-mille-native-endpoint-sha256": digest } }] } },
    { deployment: { routes: [{ headers: { "X-Mille-Native-Endpoint-SHA256": "invalid" } }] } },
  ]) {
    await assert.rejects(scenario(options).client.find(target));
  }
  const previousSha = "b".repeat(40);
  const previous = scenario({ deployment: { gitSource: { ...source, sha: previousSha }, meta: { ...metadata, milleNativePilotSha: previousSha } } });
  await assert.rejects(previous.client.find(target));
  assert.equal((await previous.client.find(target, false))?.sha, previousSha);
});

test("固定 ref の生成エイリアスだけを正確な割り当てと照合する", async () => {
  const { client, requests } = scenario({ deployment: { alias: [aliasHost] }, aliases: [{ alias: aliasHost }], directAlias: attachedAlias });
  const found = await client.find(target);
  assert.ok(found);
  await client.remove(found, current);
  assert.equal(requests.filter(request => request === `GET /v4/aliases/${aliasHost}`).length, 3);
  const collision = scenario({ deployment: null, directAlias: { ...attachedAlias, deploymentId: "dpl_Other" } });
  await assert.rejects(collision.client.provision(target, generation, current), /既に割り当て/);
  assert.equal(collision.writes.length, 0);
  const lingering = scenario({ aliases: [{ alias: aliasHost }], directAlias: attachedAlias, aliasPersists: true });
  await assert.rejects(lingering.client.remove(found, current), /既に割り当て/);
  const wrongRef = scenario();
  await assert.rejects(wrongRef.client.find({ ...target, ref: "codex/other" }));
  assert.deepEqual(wrongRef.requests, []);
  for (const badAlias of [
    undefined, { ...attachedAlias, projectId: "prj_Other" }, { ...attachedAlias, deploymentId: "dpl_Other" },
    { ...attachedAlias, redirect: "example.com" }, { ...attachedAlias, protectionBypass: { [secret]: true } },
  ]) {
    const { client } = scenario({ aliases: [{ alias: aliasHost }], directAlias: badAlias });
    await assert.rejects(client.find(target));
  }
});

test("READY を待ち、静的 index 1 件の完全な成果物だけを承認する", async () => {
  const pending = scenario({ details: reads => reads < 3
    ? { readyState: "BUILDING", routes: null, ready: null }
    : { readyState: "READY" } });
  const found = await pending.client.find(target);
  assert.ok(found);
  assert.equal(found.readyState, "BUILDING");
  assert.deepEqual(await pending.client.confirmStatic(found), {
    ...found, readyState: "READY", readyAt: deployment.ready, endpointDigest: digest,
  });
  assert.equal(pending.waits(), 1);
  for (const outputs of [
    { builds: [] }, { builds: [{ ...build, output: undefined }] }, { builds: [{ ...build, readyState: "ERROR" }] },
    { builds: [{ ...build, output: [artifact, artifact] }] }, { builds: [{ ...build, deploymentId: "dpl_Other" }] },
    { builds: [{ ...build, output: [{ ...artifact, path: "other.html" }] }] },
    { builds: [{ ...build, output: [artifact, { type: "lambda", path: "api/auth" }] }] },
    { builds: [build], pagination: { next: 50 } },
  ]) {
    const { client } = scenario({ outputs });
    const identified = await client.find(target);
    assert.ok(identified);
    await assert.rejects(client.confirmStatic(identified));
  }
  const withoutAttestation = scenario({ deployment: { routes: [] } });
  const identified = await withoutAttestation.client.find(target);
  assert.ok(identified);
  await assert.rejects(withoutAttestation.client.confirmStatic(identified), /静的な準備用ビルド/);
});

test("終了した同じ Deployment の削除を再照合し、既に削除済みでも完了する", async () => {
  const { client, requests } = scenario();
  const found = await client.find(target);
  assert.ok(found);
  await client.remove(found, current);
  await client.remove(found, current);
  assert.deepEqual(requests.filter(request => request.startsWith("DELETE")), [`DELETE /v13/deployments/${id}`]);
  assert.equal(await client.find(target), null);
  const pending = scenario({ deployment: { readyState: "BUILDING" } });
  const building = await pending.client.find(target);
  assert.ok(building);
  await assert.rejects(pending.client.remove(building, current), /ビルド終了/);
  assert.ok(pending.requests.every(request => !request.startsWith("DELETE")));
  const unchanged = scenario({ deletePersists: true });
  await assert.rejects(unchanged.client.remove(found, current), /削除を確認/);
  const stopped = scenario();
  let verified = 0;
  await assert.rejects(stopped.client.remove(found, async () => {
    if (++verified === 2) throw new Error("PR 再オープン");
  }), /PR 再オープン/);
  assert.ok(stopped.requests.every(request => !request.startsWith("DELETE")));
});
