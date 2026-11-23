import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { StandingAliasError, standingPreviewAlias, type StandingPreviewAlias, StandingPreviewVercel } from "../scripts/preview/standing-vercel";

const config = { token: "fixture-vercel-token", projectId: "prj_Standing", teamId: "team_Standing" };
const mainSha = "a".repeat(40);
const production = "dpl_Production";
const previous = "dpl_PzqN4fUewyF6MtViekWrhWSb5juw";
const deployment = "dpl_Standing";
const endpointId = "ep-bitter-wind-a1atj6vn";
const host = `${endpointId}.ap-southeast-1.aws.neon.tech`;
const database = { mode: "hosted", environment: "preview", environmentId: "mille-preview", host,
  url: `postgres://neondb_owner:fixture@${host}/neondb?sslmode=require` } as const;
const source = { sha: mainSha, database, endpointId, files: [{ file: "package.json", data: Buffer.from("{}") }] };
const ownedPreview = { id: deployment, origin: "https://mille-standing-fixture.vercel.app", sha: mainSha };
const verify = async () => {};
const liveAliases = ["mille-hazel.vercel.app", "mille-fumin1.vercel.app", "mille-git-main-fumin1.vercel.app"];
const createdAlias = { uid: "alias_fixture", alias: standingPreviewAlias, deploymentId: deployment, projectId: config.projectId } as const;
const assignedPath = `/v2/deployments/${deployment}/aliases`;
const restoredPath = `/v2/deployments/${previous}/aliases`;
const project = {
  id: config.projectId, accountId: config.teamId, name: "mille", framework: "nextjs", nodeVersion: "24.x",
  autoExposeSystemEnvs: true, ssoProtection: { deploymentType: "preview" },
  targets: { production: { id: production } },
  link: { type: "github", repoId: 1436928292, productionBranch: "main" },
};
const marker = {
  milleStandingPreviewProtocol: "mille-standing-preview/v1", milleStandingPreviewRepository: "tyask/mille",
  milleStandingPreviewSha: mainSha, milleStandingPreviewEndpointId: endpointId,
  milleStandingPreviewDbHostHash: createHash("sha256").update(host).digest("hex"),
};
const details = { projectId: config.projectId, ownerId: config.teamId, name: "mille", public: false, readyState: "READY" };
type Call = { method: string; path: string; body?: Record<string, unknown> };

function providers(wait?: (ms: number) => Promise<void>) {
  const calls: Call[] = [];
  const aliasPath = `/v4/aliases/${standingPreviewAlias}`;
  const domainPath = `/v9/projects/${config.projectId}/domains/${standingPreviewAlias}`;
  const responses = new Map<string, unknown>([
    [`/v9/projects/${config.projectId}`, project],
    [`/v10/projects/${config.projectId}/env`, { envs: [] }],
    ["/v6/deployments", { deployments: [], pagination: { count: 0, next: null } }],
    [aliasPath, null],
    [domainPath, null],
    [`/v13/deployments/${previous}`, { ...details, id: previous, url: "mille-hypzm5ss8-fumin1.vercel.app" }],
    [`/v13/deployments/${production}`, { ...details, id: production, url: "mille-production-fixture.vercel.app", target: "production",
      gitSource: { type: "github", repoId: 1436928292, ref: "main", sha: mainSha } }],
    [`/v13/deployments/${deployment}`, { ...details, id: deployment, url: new URL(ownedPreview.origin).hostname, meta: marker }],
    ...liveAliases.map((alias) => [`/v4/aliases/${alias}`, { uid: `uid-${alias.split(".")[0]}`, alias, projectId: config.projectId, deploymentId: production }] as const),
  ]);
  const api: typeof fetch = async (input, request) => {
    assert.ok(input instanceof URL);
    assert.equal(input.origin, "https://api.vercel.com");
    assert.equal(input.searchParams.get("teamId"), config.teamId);
    assert.equal(request?.redirect, "error");
    const method = request?.method ?? "GET";
    const path = input.pathname;
    const body = typeof request?.body === "string" ? JSON.parse(request.body) : undefined;
    calls.push({ method, path, body });
    const override = responses.get(`${method} ${path}`);
    if (typeof override === "function") return override();
    if (method === "POST" && path === "/v13/deployments") return Response.json({ id: deployment, target: null });
    if (method === "POST" && path === assignedPath) {
      responses.set(aliasPath, createdAlias);
      return Response.json({ uid: createdAlias.uid, alias: standingPreviewAlias });
    }
    if (method === "DELETE" && path === `/v2/aliases/${createdAlias.uid}`) {
      responses.set(aliasPath, null);
      return Response.json({ status: "SUCCESS" });
    }
    assert.equal(method, "GET");
    assert.ok(responses.has(path), path);
    const value = responses.get(path);
    if (value instanceof Response) return value;
    if (value === null) return new Response(null, { status: 404 });
    return Response.json(value);
  };
  return { vercel: new StandingPreviewVercel(config, api, wait), calls, responses, aliasPath, domainPath };
}

test("既存の常設デプロイと GitHub main の本番デプロイ・エイリアスを読み取りで照合する", async () => {
  const { vercel, calls, responses } = providers();
  assert.deepEqual(await vercel.readBaseline(), { productionDeploymentId: production, productionSha: mainSha,
    productionAliases: Object.fromEntries(liveAliases.map(name => [name, production])), legacyDeploymentId: previous });
  assert.ok(calls.every(call => call.method === "GET"));
  const alias = `/v4/aliases/${liveAliases[0]}`;
  responses.set(alias, { ...(responses.get(alias) as object), deploymentId: previous });
  await assert.rejects(vercel.readBaseline(), /本番エイリアス/);
});

test("常設 Preview を自動エイリアスなしで作成し、同じ SHA の READY を再利用する", async () => {
  const { vercel, calls, responses } = providers();
  const guards: number[] = [];
  assert.deepEqual(await vercel.deploy(source, async () => { guards.push(calls.length); }), ownedPreview);
  const postIndex = calls.findIndex(call => call.method === "POST");
  assert.ok(guards.includes(postIndex));
  const { body } = calls[postIndex];
  assert.equal(body?.autoAssignCustomDomains, false);
  assert.equal(body?.target, undefined);
  assert.equal(body?.gitSource, undefined);
  assert.deepEqual(body?.files, [{ file: "package.json", data: "e30=", encoding: "base64" }]);
  const { AUTH_SECRET, ...env } = body?.env as Record<string, string>;
  assert.match(AUTH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(env, { AUTH_MODE: "test", MILLE_SOURCE_SHA: mainSha, MILLE_PREVIEW_DATABASE_URL: database.url,
    MILLE_PREVIEW_DATABASE_HOST: host, MILLE_PREVIEW_ENVIRONMENT_ID: "mille-preview" });
  assert.deepEqual(body?.meta, marker);
  responses.set("/v6/deployments", { deployments: [{ uid: deployment, projectId: config.projectId, meta: marker }],
    pagination: { count: 1, next: null } });
  assert.deepEqual(await vercel.deploy(source, verify), ownedPreview);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("同じ SHA の BUILDING デプロイを待ち、新しい作成要求を送らない", async () => {
  const path = `/v13/deployments/${deployment}`;
  const { vercel, calls, responses } = providers(async () => { responses.set(path, ready); });
  const ready = responses.get(path) as object;
  responses.set(path, { ...ready, readyState: "BUILDING" });
  responses.set("/v6/deployments", { deployments: [{ uid: deployment, projectId: config.projectId, meta: marker }],
    pagination: { count: 1, next: null } });
  assert.deepEqual(await vercel.deploy(source, verify), ownedPreview);
  assert.equal(calls.filter(call => call.path === path).length, 3);
  assert.ok(calls.every(call => call.method === "GET"));
});

test("別の DB、外部エイリアス設定、不整合な READY の所有情報を拒否する", async () => {
  const { vercel, calls, responses } = providers();
  await assert.rejects(vercel.deploy({ ...source, endpointId: "ep-elsewhere" }, verify), /DB 接続先/);
  await assert.rejects(vercel.deploy({ ...source, files: [...source.files,
    { file: "vercel.json", data: Buffer.from(JSON.stringify({ alias: liveAliases[0] })) }] }, verify), /エイリアス/);
  assert.equal(calls.length, 0);
  const path = `/v13/deployments/${deployment}`;
  const initial = responses.get(path) as object;
  assert.deepEqual(await vercel.readDeployment(deployment, mainSha, endpointId), ownedPreview);
  for (const change of [
    { target: "production" }, { ownerId: "team_wrong" }, { readyState: "BUILDING" },
    { meta: { ...marker, milleStandingPreviewDbHostHash: "0".repeat(64) } },
    { meta: { ...marker, milleStandingPreviewSha: "b".repeat(40) } },
  ]) {
    responses.set(path, { ...initial, ...change });
    await assert.rejects(vercel.readDeployment(deployment, mainSha, endpointId));
  }
  assert.ok(calls.every(call => call.method === "GET"));
});

test("固定エイリアスだけを初回に作成し、確認済みの UID だけを取り消す", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  assert.equal(await vercel.readAlias(), null);
  assert.deepEqual(await vercel.assignAlias(deployment, verify), createdAlias);
  await assert.rejects(vercel.assignAlias(deployment, verify), /既存の割り当て/);
  assert.deepEqual(calls.filter(call => call.method === "POST"), [
    { method: "POST", path: `/v2/deployments/${deployment}/aliases`, body: { alias: standingPreviewAlias } },
  ]);
  responses.set(aliasPath, { ...createdAlias, uid: "replacement" });
  await assert.rejects(vercel.removeAlias(createdAlias, verify), /割り当てが変わりました/);
  assert.equal(calls.filter(call => call.method === "DELETE").length, 0);
  responses.set(aliasPath, createdAlias);
  await vercel.removeAlias(createdAlias, verify);
  assert.equal(await vercel.readAlias(), null);
  assert.deepEqual(calls.filter(call => call.method === "DELETE"), [{ method: "DELETE", path: `/v2/aliases/${createdAlias.uid}`, body: undefined }]);
});

test("作成後の読み戻しに失敗しても、取り消しに使う作成済み UID を返す", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  let confirmed: StandingPreviewAlias | undefined;
  await assert.rejects(vercel.assignAlias(deployment, verify, (alias) => {
    confirmed = alias;
    responses.set(aliasPath, new Response(null, { status: 502 }));
  }), error => error instanceof StandingAliasError && error.receipt.outcome === "assignment-unverified"
    && error.receipt.assignedAliasId === createdAlias.uid);
  assert.deepEqual(confirmed, createdAlias);
  responses.set(aliasPath, createdAlias);
  await vercel.removeAlias(confirmed, verify);
  assert.equal(await vercel.readAlias(), null);
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
});

test("割り当て競合で上書きした自チームの READY Preview を一度だけ復元して報告する", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  const restored = { ...createdAlias, uid: "restored", deploymentId: previous };
  responses.set(`POST ${assignedPath}`, () => {
    responses.set(aliasPath, createdAlias);
    return Response.json({ uid: createdAlias.uid, alias: standingPreviewAlias, oldDeploymentId: previous });
  });
  responses.set(`POST ${restoredPath}`, () => {
    responses.set(aliasPath, restored);
    return Response.json({ uid: restored.uid, alias: standingPreviewAlias, oldDeploymentId: deployment });
  });
  await assert.rejects(vercel.assignAlias(deployment, verify, () => assert.fail("初回割り当てとして扱いました")), (error) => {
    assert.ok(error instanceof StandingAliasError);
    assert.deepEqual(error.receipt, { alias: standingPreviewAlias, deploymentId: deployment, assignedAliasId: createdAlias.uid,
      previousDeploymentId: previous, displacedDeploymentId: deployment, observedAlias: { uid: restored.uid, deploymentId: previous },
      outcome: "conflict-restored" });
    return true;
  });
  assert.deepEqual(calls.filter(call => call.method === "POST").map(call => call.path), [assignedPath, restoredPath]);
  assert.equal(calls.some(call => call.method === "DELETE"), false);
});

test("前の組織・環境・READY または最新の割り当てが未確認なら補償しない", async () => {
  for (const scenario of [
    { previous: { ownerId: "team_Other" } }, { previous: { public: true } },
    { previous: { target: "production" } }, { previous: { readyState: "BUILDING" } },
    { binding: { ...createdAlias, uid: "new_uid" } },
  ]) {
    const { vercel, calls, responses, aliasPath } = providers();
    const path = `/v13/deployments/${previous}`;
    responses.set(path, { ...(responses.get(path) as object), ...scenario.previous });
    responses.set(`POST ${assignedPath}`, () => {
      responses.set(aliasPath, scenario.binding ?? createdAlias);
      return Response.json({ uid: createdAlias.uid, alias: standingPreviewAlias, oldDeploymentId: previous });
    });
    await assert.rejects(vercel.assignAlias(deployment, verify), error => error instanceof StandingAliasError
      && error.receipt.outcome === "conflict-unresolved" && error.receipt.previousDeploymentId === previous);
    assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => call.path), [assignedPath]);
  }
});

test("補償の応答が別の参照先を示した場合は ID を記録し、再試行しない", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  responses.set(`POST ${assignedPath}`, () => {
    responses.set(aliasPath, createdAlias);
    return Response.json({ uid: createdAlias.uid, alias: standingPreviewAlias, oldDeploymentId: previous });
  });
  responses.set(`POST ${restoredPath}`, () => {
    responses.set(aliasPath, { ...createdAlias, deploymentId: previous });
    return Response.json({ uid: createdAlias.uid, alias: standingPreviewAlias, oldDeploymentId: "dpl_ChangedAgain" });
  });
  await assert.rejects(vercel.assignAlias(deployment, verify), error => error instanceof StandingAliasError
    && error.receipt.outcome === "conflict-unresolved" && error.receipt.displacedDeploymentId === "dpl_ChangedAgain");
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => call.path), [assignedPath, restoredPath]);
});

test("初回割り当ての応答が不明なときは、後続の読み取り識別子だけを安全に報告する", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  responses.set(`POST ${assignedPath}`, () => {
    responses.set(aliasPath, createdAlias);
    return new Response("fixture-provider-body", { status: 502 });
  });
  await assert.rejects(vercel.assignAlias(deployment, verify, () => assert.fail("作成を確認済みと扱いました")), (error) => {
    assert.ok(error instanceof StandingAliasError);
    assert.deepEqual(error.receipt, { alias: standingPreviewAlias, deploymentId: deployment, outcome: "acknowledgment-unknown",
      observedAlias: { uid: createdAlias.uid, deploymentId: deployment } });
    assert.doesNotMatch(JSON.stringify(error), /fixture-provider-body/);
    return true;
  });
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => call.path), [assignedPath]);
});

test("別デプロイの固定エイリアスと照合失敗を初回作成と扱わない", async () => {
  const { vercel, calls, responses, aliasPath } = providers();
  responses.set(aliasPath, { ...createdAlias, deploymentId: previous });
  await assert.rejects(vercel.assignAlias(deployment, verify), /既存の割り当て/);
  responses.set(aliasPath, new Response(null, { status: 403 }));
  await assert.rejects(vercel.assignAlias(deployment, verify), /403/);
  assert.ok(calls.every(call => call.method === "GET"));
});

test("固定ホストがプロジェクトのドメインである場合はデプロイとエイリアス作成を拒否する", async () => {
  const { vercel, calls, responses, domainPath } = providers();
  await vercel.preflight();
  responses.set(domainPath, { name: standingPreviewAlias, projectId: config.projectId });
  await assert.rejects(vercel.deploy(source, verify), /ドメインに登録/);
  await assert.rejects(vercel.assignAlias(deployment, verify), /ドメインに登録/);
  assert.ok(calls.every(call => call.method === "GET"));
});
