import assert from "node:assert/strict";
import test from "node:test";
import { formatNativePilotFailure, NativePilotStageError } from "../scripts/preview/native-pilot-diagnostics";
import { NativePilotVercel } from "../scripts/preview/native-pilot-vercel";

const config = {
  token: "fixture-management-token", teamId: "team_Mille", projectId: "prj_Mille",
};
const repoId = 1436928292;
const target = { pr: 17, ref: "codex/native-preview-pilot-a", sha: "a".repeat(40) };
const generation = "b6ec6368-a4b9-47a5-99d0-7d15014fe50e";
const id = "dpl_Pilot";
const applicationId = "dpl_Application";
const secondApplicationId = "dpl_Application2";
const aliasHost = "mille-git-codex-native-preview-pilot-a-fumin1.vercel.app";
const aliasUid = "alias_Pilot";
const attachedAlias = { alias: aliasHost, uid: aliasUid, projectId: config.projectId, deploymentId: id, redirect: null };
const endpointId = "ep-fixture-native";
const database = { branchId: "br-fixture-native", endpointId, hostDigest: "a".repeat(64) };
const updatedTarget = { ...target, sha: "b".repeat(40) };
const evidenceText = `Mille: Native Preview 静的ビルド照合 v1 ${id} ${target.pr} ${target.ref} ${target.sha} ${generation} ${endpointId}`;
const secret = "sensitive-fixture-must-never-appear";
const variable = "MILLE_NATIVE_PREVIEW_DATABASE_URL";
const project = {
  id: config.projectId, name: "mille", accountId: config.teamId,
  link: { type: "github", repoId, productionBranch: "main" }, framework: "nextjs", nodeVersion: "24.x",
  autoExposeSystemEnvs: true, ssoProtection: { deploymentType: "all_except_custom_domains" },
};
const nativeEnv = {
  key: variable, target: ["preview"], contentHint: { type: "integration-store-secret" },
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
  url: "mille-pilot-fumin1.vercel.app", createdAt: 20001, ready: 21000, readyState: "READY", meta: metadata, gitSource: source, routes: null,
};
const applicationMetadata = {
  milleNativePilotPhase: "application", milleNativePilotBranchId: database.branchId,
  milleNativePilotEndpointId: database.endpointId, milleNativePilotHostDigest: database.hostDigest,
};
const application = {
  ...deployment, id: applicationId, functions: { api: {} },
  meta: { ...metadata, ...applicationMetadata },
};
const updatedApplication = {
  ...application, id: secondApplicationId, gitSource: { ...source, sha: updatedTarget.sha },
  meta: { ...application.meta, milleNativePilotSha: updatedTarget.sha },
};
const evidenceEvent = { id: "event_evidence", created: 20950, deploymentId: id, type: "stdout", info: { type: "build" }, text: evidenceText };
const unrelatedEvent = { id: "event_other", deploymentId: id, type: "stderr", info: { type: "build" }, text: secret };

function applicationEvent(record: typeof application = application, endpoint: string = endpointId) {
  return {
    ...evidenceEvent, deploymentId: record.id,
    text: `Mille: Native Preview アプリビルド照合 v1 ${record.id} ${target.pr} ${target.ref} ${record.gitSource.sha} ${generation} ${endpoint}`,
  };
}
type ListEntry = { uid: string; projectId: string; meta?: object; gitSource?: object };
type Input = Record<string, unknown>;

function scenario(options: {
  project?: Input; projectResponse?: Response; envs?: readonly unknown[]; envPagination?: Input; deployment?: Input | null; deployments?: Input[];
  details?: (requestNumber: number) => Input; inventory?: (cursor: string | null) => { deployments: ListEntry[]; pagination: { count: number; next: number | null } };
  events?: (requestNumber: number, id: string) => unknown; eventsResponse?: Response; aliases?: unknown[]; directAlias?: Input;
  aliasResponse?: Response;
  aliasReadback?: (requestNumber: number) => Input; deletePersists?: boolean; aliasPersists?: boolean;
  postResponse?: Response; throwPost?: boolean; readbackResponse?: Response;
} = {}) {
  const requests: string[] = [];
  const writes: Input[] = [];
  const records = options.deployments ?? (options.deployment === null ? [] : [{ ...deployment, ...options.deployment }]);
  const existing = new Map(records.map(item => [String(item.id), { ...item }]));
  let aliases = options.aliases;
  let directAlias = options.directAlias;
  let detailsRead = 0;
  let eventsRead = 0;
  let aliasesRead = 0;
  let waits = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), config.teamId);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${config.token}`);
    assert.equal(init?.redirect, "error");
    const method = init?.method;
    requests.push(`${method} ${url.pathname}`);
    switch (url.pathname) {
      case `/v9/projects/${config.projectId}`: return options.projectResponse ?? Response.json({ ...project, ...options.project });
      case `/v10/projects/${config.projectId}/env`:
        assert.equal(url.searchParams.get("decrypt"), "false");
        return Response.json({ envs: options.envs ?? [nativeEnv], pagination: options.envPagination });
      case "/v6/deployments": {
        assert.equal(url.searchParams.get("projectId"), config.projectId);
        assert.equal(url.searchParams.get("limit"), "100");
        const items = [...existing.values()].map(item => ({ uid: item.id, projectId: config.projectId, meta: item.meta }));
        return Response.json(options.inventory?.(url.searchParams.get("until"))
          ?? { deployments: items, pagination: { count: items.length, next: null } });
      }
      case "/v13/deployments": {
        assert.equal(method, "POST");
        assert.equal(url.searchParams.get("forceNew"), "1");
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        const requestedAt = Number(body.meta.milleNativePilotRequestedAt);
        const createdId = body.meta.milleNativePilotPhase === "provision" ? id
          : existing.has(applicationId) ? secondApplicationId : applicationId;
        existing.set(createdId, {
          ...deployment, id: createdId, createdAt: requestedAt + 1, ready: requestedAt + 2, meta: body.meta, gitSource: body.gitSource,
        });
        if (options.throwPost) throw new Error(secret);
        return options.postResponse ?? Response.json({ id: createdId });
      }
      case `/v4/aliases/${aliasHost}`: {
        const value = options.aliasReadback?.(++aliasesRead) ?? directAlias;
        if (options.aliasResponse) return options.aliasResponse;
        return value ? Response.json(value) : new Response(null, { status: 404 });
      }
      case `/v2/aliases/${aliasUid}`:
        assert.equal(method, "DELETE");
        if (!options.aliasPersists) {
          // Vercel can retain the old alias in the deployment detail after deleting the live assignment.
          aliases = undefined;
          directAlias = undefined;
        }
        return Response.json({ status: "SUCCESS" });
    }
    const detail = /^\/v13\/deployments\/(dpl_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (detail) {
      if (method === "DELETE") {
        if (!options.deletePersists) existing.delete(detail[1]);
        return new Response(null, { status: 204 });
      }
      assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
      if (options.readbackResponse) return options.readbackResponse;
      const record = existing.get(detail[1]);
      return record ? Response.json({ ...record, ...options.details?.(++detailsRead) }) : new Response(null, { status: 404 });
    }
    if (/^\/v2\/deployments\/dpl_[A-Za-z0-9]+\/aliases$/.test(url.pathname)) return Response.json({ aliases: aliases ?? [] });
    const events = /^\/v3\/deployments\/(dpl_[A-Za-z0-9]+)\/events$/.exec(url.pathname);
    if (events) {
      assert.equal(method, "GET");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        builds: "1", follow: "0", direction: "forward", limit: "200", teamId: config.teamId,
      });
      return options.eventsResponse ?? Response.json(options.events?.(++eventsRead, events[1]) ?? [unrelatedEvent, evidenceEvent]);
    }
    assert.fail("未定義の Vercel API リクエストです。");
  };
  return { client: new NativePilotVercel(config, request, async () => { waits++; }), requests, writes, waits: () => waits };
}

const current = async () => {};

test("プロジェクトと Preview 専用変数を既存資格情報で復号なしに照合する", async () => {
  const standing = { key: "DATABASE_URL", target: ["preview"], gitBranch: "mille-standing-preview", value: secret };
  const { client, requests } = scenario({ envs: [standing, nativeEnv, { key: "AUTH_SECRET", target: ["production"] }] });
  await client.preflight();
  assert.deepEqual(requests, [`GET /v9/projects/${config.projectId}`, `GET /v10/projects/${config.projectId}/env`]);
});

test("不完全な連携変数、共有スコープ、誤ったプロジェクトと保護の解除を拒否する", async () => {
  for (const options of [
    { envs: [] },
    { envs: [nativeEnv, nativeEnv] },
    { envs: [nativeEnv, { ...nativeEnv, key: "MILLE_NATIVE_PREVIEW_NEON_AUTH_BASE_URL" }] },
    { envs: [nativeEnv, { ...nativeEnv, key: "MILLE_NATIVE_PREVIEW_NEON_AUTH_BASE_URL", target: ["production"] }] },
    { envs: [{ ...nativeEnv, gitBranch: "mille-standing-preview" }] },
    { envs: [{ ...nativeEnv, customEnvironmentIds: ["env_Other"] }] },
    { envPagination: { count: 2, next: null } },
    { envPagination: { count: 1, next: 123 } },
    { envs: [{ key: variable, target: ["preview"] }] },
    { envs: [nativeEnv, { key: "DATABASE_URL", target: ["preview"], gitBranch: target.ref }] },
    { envs: [{ ...nativeEnv, target: ["production", "preview"] }] },
    { envs: [nativeEnv, { ...nativeEnv, target: ["production"] }] },
    { project: { env: [{ key: "DATABASE_URL", target: ["preview"] }] } },
    { project: { connectBuildsEnabled: true } },
    { project: { integrations: [{ id: "other" }] } },
    { project: { ssoProtection: null } },
    { project: { protectionBypass: { [secret]: true } } },
    { project: { id: "prj_Other" } },
    { project: { accountId: "team_Other" } },
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

test("確認済みの Git ソースと準備用環境変数だけで Preview を作成する", async () => {
  const { client, writes } = scenario({ deployment: null });
  let verified = 0;
  const result = await client.provision(target, generation, async () => { verified++; });
  assert.equal(verified, 2);
  assert.equal(writes.length, 1);
  const { meta, env, ...body } = writes[0];
  assert.deepEqual(body, { project: config.projectId, name: "mille", gitSource: source, build: { env } });
  assert.deepEqual(env, {
    AUTH_MODE: "test", MILLE_NATIVE_PREVIEW_PHASE: "provision", MILLE_NATIVE_PREVIEW_PR: "17",
    MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: target.ref, MILLE_NATIVE_PREVIEW_SOURCE_SHA: target.sha,
    MILLE_NATIVE_PREVIEW_GENERATION: generation, MILLE_NATIVE_PREVIEW_ATTEST_ENDPOINT: "1",
  });
  assert.deepEqual(meta, { ...metadata, milleNativePilotRequestedAt: String(result.requestedAt) });
  assert.equal(result.url, `https://${deployment.url}`);
  assert.ok(result.createdAt >= result.requestedAt);
  assert.equal(result.readyAt, result.createdAt + 1);
  assert.doesNotMatch(JSON.stringify(writes), /fixture-management-token|sensitive-fixture/);
});

test("作成時の状態変更や不明な POST 結果を停止し、再試行で二重作成しない", async () => {
  const stopped = scenario({ deployment: null });
  await assert.rejects(stopped.client.provision(target, generation, async () => { throw new Error("PR 更新"); }), /PR 更新/);
  assert.equal(stopped.writes.length, 0);
  const uncertain = scenario({ deployment: null, postResponse: Response.json({ message: secret }, { status: 500 }) });
  await assert.rejects(uncertain.client.provision(target, generation, current), /HTTP 500/);
  assert.equal((await uncertain.client.list(target))[0]?.generation, generation);
  await assert.rejects(uncertain.client.provision(target, generation, current), /作成済み/);
  assert.equal(uncertain.writes.length, 1);
});

test("事前照合と作成要求・応答の失敗を固定工程と HTTP 状態で区別する", async () => {
  const denied = scenario({ deployment: null, projectResponse: new Response(secret, { status: 403 }) });
  await assert.rejects(denied.client.provision(target, generation, current), error => {
    assert.ok(error instanceof NativePilotStageError);
    assert.equal(error.stage, "vercel-preflight");
    assert.equal(formatNativePilotFailure(error), "Native Preview 診断 Vercel のプロジェクト・環境変数照合 (HTTP 403)");
    return true;
  });
  assert.equal(denied.writes.length, 0);

  const cases = [
    { options: { postResponse: new Response(secret, { status: 403 }) }, stage: "vercel-create-request", status: " (HTTP 403)" },
    { options: { throwPost: true }, stage: "vercel-create-request", status: "" },
    { options: { postResponse: new Response(secret, { status: 201 }) }, stage: "vercel-create-response", status: " (HTTP 201)" },
    { options: { postResponse: Response.json({ id: secret }, { status: 201 }) }, stage: "vercel-create-response", status: " (HTTP 201)" },
    { options: { readbackResponse: new Response(secret, { status: 404 }) }, stage: "vercel-create-response", status: " (HTTP 404)" },
    { options: { readbackResponse: Response.json({ id: secret }) }, stage: "vercel-create-response", status: " (HTTP 200)" },
    { options: { details: () => ({ ownerId: "team_Other" }) }, stage: "vercel-create-response", status: " (HTTP 200)" },
    { options: { details: () => ({ public: true }) }, stage: "vercel-create-response", status: " (HTTP 200)" },
    { options: { details: () => ({ public: undefined }) }, stage: "vercel-create-response", status: " (HTTP 200)" },
  ];
  for (const { options, stage, status } of cases) {
    const failed = scenario({ deployment: null, ...options });
    await assert.rejects(failed.client.provision(target, generation, current), error => {
      assert.ok(error instanceof NativePilotStageError);
      assert.equal(error.stage, stage);
      const label = stage === "vercel-create-request" ? "デプロイ作成要求" : "デプロイ作成応答・所有照合";
      assert.equal(formatNativePilotFailure(error), `Native Preview 診断 Vercel の${label}${status}`);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.deepEqual(failed.requests.filter(request => request.startsWith("POST ")), ["POST /v13/deployments"]);
  }
});

test("作成拒否の診断を固定ラベルに限定し、失敗した POST を自動再送しない", async t => {
  const log = t.mock.method(console, "log", () => {});
  const error = (code: string, message = secret) => Response.json({
    error: { code, message, url: `https://${secret}.example`, value: config.token },
  }, { status: 400 });
  const cases = [
    { response: error("missing_files"), label: "デプロイに必要なファイルが不足" },
    { response: error("no_files"), label: "デプロイ対象のファイルが空" },
    { response: error("env_too_many_keys"), label: "環境変数の件数上限を超過" },
    { response: error("bad_request", `Invalid request: additional property public (${secret})`) },
    { response: error(secret) },
    { response: new Response(secret, { status: 400 }) },
  ];
  for (const { response, label } of cases) {
    log.mock.resetCalls();
    const failed = scenario({ deployment: null, postResponse: response });
    await assert.rejects(failed.client.provision(target, generation, current), error => {
      assert.ok(error instanceof NativePilotStageError);
      assert.equal(error.stage, "vercel-create-request");
      assert.equal(error.message, "Vercel API POST が失敗しました (HTTP 400)。");
      assert.equal(formatNativePilotFailure(error), "Native Preview 診断 Vercel のデプロイ作成要求 (HTTP 400)");
      return true;
    });
    const expected = [["Native Preview 診断 Vercel のデプロイ作成要求を開始しました。"]];
    if (label) expected.push([`Native Preview 診断 Vercel のデプロイ作成要求（${label}） (HTTP 400)。`]);
    assert.deepEqual(log.mock.calls.map(call => call.arguments), expected);
    assert.deepEqual(failed.requests.filter(request => request.startsWith("POST ")), ["POST /v13/deployments"]);
  }
});

test("一覧を全ページ調べ、同じ ref の別 Deployment と不完全なページを拒否する", async () => {
  const own = { uid: id, projectId: config.projectId, meta: metadata };
  const unrelated = { uid: "dpl_Standing", projectId: config.projectId, meta: { githubCommitRef: "main" } };
  const pages = (cursor: string | null) => cursor === null
    ? { deployments: [unrelated], pagination: { count: 1, next: 100 } }
    : { deployments: [own], pagination: { count: 1, next: null } };
  assert.equal((await scenario({ inventory: pages }).client.list(target))[0]?.id, id);
  for (const options of [
    { deployment: { meta: { githubCommitRef: target.ref } }, inventory: () => ({ deployments: [{ ...own, meta: { githubCommitRef: target.ref } }], pagination: { count: 1, next: null } }) },
    { inventory: () => ({ deployments: [own], pagination: { count: 1, next: 25 } }) },
    { inventory: () => ({ deployments: [own], pagination: { count: 2, next: null } }) },
    { deployment: { target: "production" } }, { deployment: { public: true } },
    { aliases: [{ alias: "mille-fumin1.vercel.app" }] }, { deployment: { alias: ["mille-fumin1.vercel.app"] } },
    { deployment: { gitSource: { ...source, repoId: 42 } } }, { deployment: { gitSource: { ...source, ref: "codex/other" } } },
    { deployment: { createdAt: 19000 } }, { deployment: { ready: null } }, { deployment: { ready: 20000 } },
    { deployment: { functions: { api: {} } } }, { deployment: { crons: [{ path: "/api" }] } },
  ]) {
    await assert.rejects(scenario(options).client.list(target));
  }
  const previousSha = "b".repeat(40);
  const previous = scenario({ deployment: { gitSource: { ...source, sha: previousSha }, meta: { ...metadata, milleNativePilotSha: previousSha } } });
  assert.equal((await previous.client.list(target))[0]?.sha, previousSha);
});

test("一覧にあるデプロイと静的ビルドの読み戻しに失敗した場合は HTTP 404 を維持する", async () => {
  const { client, requests } = scenario({ readbackResponse: new Response(secret, { status: 404 }) });
  await assert.rejects(client.list(target), /HTTP 404/);
  const { client: verified, waits } = scenario({ eventsResponse: new Response(secret, { status: 404 }) });
  const [found] = await verified.list(target);
  assert.ok(found);
  await assert.rejects(verified.confirmStatic(found), /HTTP 404/);
  assert.equal(waits(), 0);
  assert.ok(requests.every(request => request.startsWith("GET ")));
});

test("固定 ref の生成エイリアスだけを正確な割り当てと照合する", async () => {
  const { client, requests } = scenario({ deployment: { alias: [aliasHost] }, aliases: [{ alias: aliasHost }], directAlias: attachedAlias });
  const [found] = await client.list(target);
  assert.ok(found);
  await client.remove(found, current);
  assert.deepEqual(requests.filter(request => request.startsWith("DELETE")), [
    `DELETE /v2/aliases/${aliasUid}`, `DELETE /v13/deployments/${id}`,
  ]);
  const aliasDelete = requests.indexOf(`DELETE /v2/aliases/${aliasUid}`);
  const deploymentDelete = requests.indexOf(`DELETE /v13/deployments/${id}`);
  assert.ok(requests.slice(aliasDelete + 1, deploymentDelete).includes(`GET /v4/aliases/${aliasHost}`));
  assert.ok(requests.slice(deploymentDelete + 1).includes(`GET /v4/aliases/${aliasHost}`));
  assert.ok(requests.slice(deploymentDelete + 1).includes(`GET /v13/deployments/${id}`));
  const collision = scenario({ deployment: null, directAlias: { ...attachedAlias, deploymentId: "dpl_Other" } });
  await assert.rejects(collision.client.provision(target, generation, current), /割り当てを確認/);
  assert.equal(collision.writes.length, 0);
  const invalid = scenario({ deployment: null, aliasResponse: Response.json(null) });
  await assert.rejects(invalid.client.list(target), { status: 200 });
  const nullDeployment = scenario({ readbackResponse: Response.json(null) });
  await assert.rejects(nullDeployment.client.remove(found, current), { status: 200 });
  assert.ok(nullDeployment.requests.every(request => !request.startsWith("DELETE")));
  const lingering = scenario({ aliases: [{ alias: aliasHost }], directAlias: attachedAlias, aliasPersists: true });
  await assert.rejects(lingering.client.remove(found, current), /エイリアスが残っています/);
  assert.deepEqual(lingering.requests.filter(request => request.startsWith("DELETE")), [`DELETE /v2/aliases/${aliasUid}`]);
  const conflicting = scenario({ aliases: [{ alias: aliasHost }] });
  await assert.rejects(conflicting.client.remove(found, current), { status: 404 });
  assert.ok(conflicting.requests.every(request => !request.startsWith("DELETE")));
  const reassigned = scenario({ directAlias: attachedAlias, aliasReadback: reads => reads === 3
    ? { ...attachedAlias, deploymentId: "dpl_Other" } : attachedAlias });
  const [beforeReassignment] = await reassigned.client.list(target);
  assert.ok(beforeReassignment);
  await assert.rejects(reassigned.client.remove(beforeReassignment, current), /割り当てを確認/);
  assert.ok(reassigned.requests.every(request => !request.startsWith("DELETE")));
  const wrongRef = scenario();
  await assert.rejects(wrongRef.client.list({ ...target, ref: "codex/other" }));
  assert.deepEqual(wrongRef.requests, []);
  for (const badAlias of [
    { ...attachedAlias, projectId: "prj_Other" }, { ...attachedAlias, deploymentId: "dpl_Other" },
    { ...attachedAlias, uid: "../other" }, { ...attachedAlias, uid: undefined },
    { ...attachedAlias, redirect: "example.com" }, { ...attachedAlias, protectionBypass: { [secret]: true } },
  ]) {
    const { client } = scenario({ aliases: [{ alias: aliasHost }], directAlias: badAlias });
    await assert.rejects(client.list(target));
  }
});

test("詳細に削除済みエイリアスが残っていてもデプロイの削除を再開する", async () => {
  const { client, requests } = scenario({ deployments: [{ ...application, alias: [aliasHost] }] });
  const [found] = await client.list(target);
  assert.equal(found?.phase, "application");
  assert.ok(found);
  await client.remove(found, current);
  assert.deepEqual(requests.filter(request => request.startsWith("DELETE")), [`DELETE /v13/deployments/${applicationId}`]);
  assert.deepEqual(await client.list(target), []);
});

test("READY と同じ Deployment の静的ビルド照合記録を待つ", async () => {
  const pending = scenario({ details: reads => reads < 3
    ? { readyState: "BUILDING", ready: null }
    : { readyState: "READY" }, events: reads => reads === 1 ? [unrelatedEvent] : [unrelatedEvent, evidenceEvent] });
  const [found] = await pending.client.list(target);
  assert.ok(found);
  assert.equal(found.readyState, "BUILDING");
  assert.deepEqual(await pending.client.confirmStatic(found), {
    ...found, readyState: "READY", readyAt: deployment.ready, endpointId,
  });
  assert.equal(pending.waits(), 2);
  assert.equal(pending.requests.filter(request => request === `GET /v3/deployments/${id}/events`).length, 2);
  const previousSha = "b".repeat(40);
  const previous = scenario({
    deployment: { gitSource: { ...source, sha: previousSha }, meta: { ...metadata, milleNativePilotSha: previousSha } },
    events: () => [{ ...evidenceEvent, text: evidenceText.replace(target.sha, previousSha) }],
  });
  const [identified] = await previous.client.list(target);
  assert.ok(identified);
  assert.equal((await previous.client.confirmStatic(identified)).endpointId, endpointId);
});

test("重複、切れた一覧、別の所有情報、形式不正の静的ビルド照合記録を直ちに拒否する", async () => {
  for (const events of [
    [evidenceEvent, evidenceEvent], [evidenceEvent, ...Array(199).fill(unrelatedEvent)], { events: [evidenceEvent] },
    [{ ...evidenceEvent, deploymentId: "dpl_Other" }], [{ ...evidenceEvent, type: "stderr" }],
    [{ ...evidenceEvent, info: { type: "runtime" } }],
    ...[
      evidenceText.replace(id, "dpl_Other"), evidenceText.replace(" 17 ", " 18 "),
      evidenceText.replace(target.ref, "codex/native-preview-pilot-b"), evidenceText.replace(target.sha, "b".repeat(40)),
      evidenceText.replace(generation, "dc54f877-d22f-4ab7-b5d7-c90532fde379"),
      evidenceText.replace(endpointId, secret), evidenceText.replace(endpointId, `${endpointId}-pooler`),
      evidenceText.replace("v1", "v2"), `prefix ${evidenceText}`, `${evidenceText}\n`, `${evidenceText} extra`,
    ].map(text => [{ ...evidenceEvent, text }]),
  ]) {
    const { client, waits } = scenario({ events: () => events });
    const [identified] = await client.list(target);
    assert.ok(identified);
    await assert.rejects(client.confirmStatic(identified), (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.equal(waits(), 0);
  }
  const withoutAttestation = scenario({ events: () => [unrelatedEvent] });
  const [identified] = await withoutAttestation.client.list(target);
  assert.ok(identified);
  await assert.rejects(withoutAttestation.client.confirmStatic(identified), /静的な準備用ビルド照合記録を確認できません/);
  assert.equal(withoutAttestation.waits(), 120);
});

test("終了した同じ Deployment の削除を再照合し、既に削除済みでも完了する", async () => {
  const { client, requests } = scenario();
  const [found] = await client.list(target);
  assert.ok(found);
  await client.remove(found, current);
  await client.remove(found, current);
  assert.deepEqual(requests.filter(request => request.startsWith("DELETE")), [`DELETE /v13/deployments/${id}`]);
  assert.deepEqual(await client.list(target), []);
  const pending = scenario({ deployment: { readyState: "BUILDING" } });
  const [building] = await pending.client.list(target);
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
  for (const directAlias of [undefined, attachedAlias]) {
    const reopened = scenario({ directAlias });
    await assert.rejects(reopened.client.remove(found, async () => {
      const checked = reopened.requests.filter(request => request === `GET /v4/aliases/${aliasHost}`);
      if (checked.length >= 2) throw new Error("PR 再オープン");
    }), /PR 再オープン/);
    assert.ok(reopened.requests.every(request => !request.startsWith("DELETE")));
  }
});

test("所有する Deployment の終了を待ち、終了状態をビルド記録なしで確認する", async () => {
  for (const readyState of ["READY", "ERROR", "CANCELED", "BLOCKED"]) {
    const fixture = scenario({ details: reads => reads < 3
      ? { readyState: "BUILDING", ready: null }
      : { readyState, ready: readyState === "READY" ? deployment.ready : null }, events: () => assert.fail("ビルド記録の取得は不要です。") });
    const [pending] = await fixture.client.list(target);
    let verified = 0;
    const finished = await fixture.client.waitForTerminal(pending, async () => { verified++; });
    assert.equal(finished.id, pending.id);
    assert.equal(finished.readyState, readyState);
    assert.equal(fixture.waits(), 1);
    assert.equal(verified, 3);
    assert.ok(fixture.requests.every(request => request.startsWith("GET ")));
  }
  const changed = scenario({ details: reads => ({
    readyState: "BUILDING", ready: null, url: reads === 1 ? deployment.url : "different-pilot.vercel.app",
  }) });
  const [pending] = await changed.client.list(target);
  await assert.rejects(changed.client.waitForTerminal(pending, current), /所有が変わりました/);
  assert.equal(changed.waits(), 0);
});

test("異なる SHA のアプリと静的な準備を同一世代として一覧に含める", async () => {
  const owned = scenario({ deployments: [updatedApplication, application, deployment],
    directAlias: { ...attachedAlias, deploymentId: applicationId } });
  const listed = await owned.client.list(updatedTarget);
  assert.deepEqual(listed.map(item => [item.id, item.phase, item.sha, item.generation, item.database]), [
    [secondApplicationId, "application", updatedTarget.sha, generation, database],
    [applicationId, "application", target.sha, generation, database],
    [id, "provision", target.sha, generation, undefined],
  ]);
  for (const deployments of [
    [deployment, { ...deployment, id: "dpl_SecondProvision" }],
    [deployment, application, { ...application, id: "dpl_Duplicate" }],
    [deployment, { ...application, meta: { ...application.meta, milleNativePilotGeneration: "dc54f877-d22f-4ab7-b5d7-c90532fde379" } }],
    [application, { ...updatedApplication, meta: { ...updatedApplication.meta, milleNativePilotBranchId: "br-other" } }],
    [deployment, { ...application, crons: [{ path: "/api" }] }],
    [deployment, { ...application, meta: { ...application.meta, milleNativePilotHostDigest: undefined } }],
  ]) {
    await assert.rejects(scenario({ deployments }).client.list(updatedTarget));
  }
  await assert.rejects(scenario({ deployments: [deployment, application],
    directAlias: { ...attachedAlias, deploymentId: secondApplicationId } }).client.list(target), /割り当てを確認/);
});

test("照合済みの静的ビルドを使い、同じ世代と DB に SHA ごとにアプリを作成する", async () => {
  const { client, writes } = scenario({ directAlias: attachedAlias });
  const deployed = await client.deployApplication(target, generation, database, current);
  assert.equal(deployed.phase, "application");
  assert.deepEqual(deployed.database, database);
  assert.equal(deployed.sha, target.sha);
  const updated = await client.deployApplication(updatedTarget, generation, database, current);
  assert.equal(updated.sha, updatedTarget.sha);
  assert.equal(updated.generation, generation);
  assert.deepEqual(updated.database, database);
  assert.equal(writes.length, 2);
  const { env, meta, ...body } = writes[1];
  const { AUTH_SECRET: sessionSecret, ...applicationEnvironment } = env as Input;
  assert.match(String(sessionSecret), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(sessionSecret, (writes[0].env as Input).AUTH_SECRET);
  assert.ok(!Object.values(meta as Input).includes(sessionSecret));
  assert.deepEqual(body, { project: config.projectId, name: "mille", gitSource: { ...source, sha: updatedTarget.sha }, build: { env } });
  assert.deepEqual(applicationEnvironment, {
    AUTH_MODE: "test", MILLE_NATIVE_PREVIEW_PHASE: "application", MILLE_NATIVE_PREVIEW_PR: "17",
    MILLE_NATIVE_PREVIEW_SOURCE_BRANCH: target.ref, MILLE_NATIVE_PREVIEW_SOURCE_SHA: updatedTarget.sha,
    MILLE_NATIVE_PREVIEW_GENERATION: generation, MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID: database.branchId,
    MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID: database.endpointId, MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256: database.hostDigest,
  });
  assert.deepEqual(meta, {
    ...metadata, ...applicationMetadata, milleNativePilotSha: updatedTarget.sha,
    milleNativePilotRequestedAt: String(updated.requestedAt),
  });
  assert.doesNotMatch(JSON.stringify(writes), /fixture-management-token|sensitive-fixture|DATABASE_URL/);
});

test("アプリの新規作成前に準備の世代、接続先、重複と従来の DB を照合する", async () => {
  const otherGeneration = "dc54f877-d22f-4ab7-b5d7-c90532fde379";
  for (const input of [
    { records: [] }, { records: [application] }, { records: [deployment], generation: otherGeneration },
    { records: [deployment], database: { ...database, endpointId: "ep-other" } },
    { records: [deployment, updatedApplication] },
    { records: [deployment, application], database: { ...database, hostDigest: "c".repeat(64) } },
  ]) {
    const fixture = scenario({ deployments: input.records });
    await assert.rejects(fixture.client.deployApplication(updatedTarget, input.generation ?? generation, input.database ?? database, current));
    assert.equal(fixture.writes.length, 0);
  }
  const unknown = scenario({ postResponse: new Response(secret, { status: 500 }) });
  await assert.rejects(unknown.client.deployApplication(target, generation, database, current), /HTTP 500/);
  await assert.rejects(unknown.client.deployApplication(target, generation, database, current), /作成済み/);
  assert.equal(unknown.writes.length, 1);
});

test("静的な準備が期限切れのときは同じ DB の READY アプリを再照合して新しい SHA を作成する", async () => {
  const appAlias = { ...attachedAlias, deploymentId: applicationId };
  const fixture = scenario({ deployments: [application], directAlias: appAlias, events: () => [applicationEvent()] });
  const updated = await fixture.client.deployApplication(updatedTarget, generation, database, current);
  assert.equal(updated.sha, updatedTarget.sha);
  assert.equal(updated.generation, generation);
  assert.deepEqual(updated.database, database);
  assert.equal(fixture.writes.length, 1);
  assert.ok(fixture.requests.includes(`GET /v3/deployments/${applicationId}/events`));

  for (const events of [[], [evidenceEvent], [applicationEvent(application, "ep-other")]]) {
    const missing = scenario({ deployments: [application], directAlias: appAlias, events: () => events });
    await assert.rejects(missing.client.deployApplication(updatedTarget, generation, database, current), (error: Error) => {
      assert.ok(error instanceof NativePilotStageError);
      assert.equal(error.stage, "vercel-application");
      return true;
    });
    assert.equal(missing.writes.length, 0);
  }
  const changed = scenario({ deployments: [application], directAlias: appAlias, events: () => [applicationEvent()],
    details: reads => reads > 2 ? { ready: application.ready + 1 } : {} });
  await assert.rejects(changed.client.deployApplication(updatedTarget, generation, database, current), /所有が変わりました/);
  assert.equal(changed.writes.length, 0);
});

test("READY のアプリに対応するビルド照合記録と DB メタデータを確認する", async () => {
  const fixture = scenario({ deployments: [deployment, updatedApplication],
    events: (_reads, id) => id === secondApplicationId ? [unrelatedEvent, applicationEvent(updatedApplication)] : [evidenceEvent] });
  const listed = await fixture.client.list(updatedTarget);
  const app = listed.find(item => item.phase === "application");
  assert.ok(app);
  assert.deepEqual(await fixture.client.confirmApplication(app), { ...app, endpointId });
  await assert.rejects(fixture.client.confirmStatic(app), /静的な準備用 Deployment/);
  for (const events of [
    [applicationEvent(updatedApplication, "ep-other")], [evidenceEvent, applicationEvent(updatedApplication)],
    [applicationEvent()], [applicationEvent(updatedApplication), applicationEvent(updatedApplication)],
  ]) {
    const wrong = scenario({ deployments: [updatedApplication], events: () => events });
    await assert.rejects(wrong.client.confirmApplication(app));
    assert.equal(wrong.waits(), 0);
  }
});

test("同じ世代の別デプロイに移ったエイリアスを保ち、最後のアプリと共に削除する", async () => {
  const aliasForLatest = { ...attachedAlias, deploymentId: secondApplicationId };
  const fixture = scenario({ deployments: [deployment, application, updatedApplication], directAlias: aliasForLatest });
  const [anchor, old, latest] = await fixture.client.list(updatedTarget);
  await fixture.client.remove(old, current);
  await fixture.client.remove(anchor, current);
  assert.deepEqual((await fixture.client.list(updatedTarget)).map(item => item.id), [secondApplicationId]);
  assert.deepEqual(fixture.requests.filter(request => request.startsWith("DELETE")), [
    `DELETE /v13/deployments/${applicationId}`, `DELETE /v13/deployments/${id}`,
  ]);
  await fixture.client.remove(latest, current);
  assert.deepEqual(await fixture.client.list(updatedTarget), []);
  assert.deepEqual(fixture.requests.filter(request => request.startsWith("DELETE")).slice(-2), [
    `DELETE /v2/aliases/${aliasUid}`, `DELETE /v13/deployments/${secondApplicationId}`,
  ]);
  const reassign = scenario({ deployments: [application, updatedApplication],
    aliasReadback: reads => reads >= 3 ? aliasForLatest : { ...attachedAlias, deploymentId: applicationId } });
  const [replaced] = await reassign.client.list(updatedTarget);
  await reassign.client.remove(replaced, current);
  assert.deepEqual(reassign.requests.filter(request => request.startsWith("DELETE")), [`DELETE /v13/deployments/${applicationId}`]);
  const newGeneration = { ...updatedApplication, meta: { ...updatedApplication.meta,
    milleNativePilotGeneration: "dc54f877-d22f-4ab7-b5d7-c90532fde379" } };
  const foreign = scenario({ deployments: [application, newGeneration], directAlias: aliasForLatest });
  await assert.rejects(foreign.client.remove(old, current), /世代/);
  assert.ok(foreign.requests.every(request => !request.startsWith("DELETE")));
});
