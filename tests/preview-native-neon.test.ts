import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { NativePilotHttpError, NativePilotStageError, formatNativePilotFailure } from "../scripts/preview/native-pilot-diagnostics";
import { NeonPreview, NeonPreviewError, type NativeNeonBranch } from "../scripts/preview/neon";

const config = { apiKey: "fixture-api-token", projectId: "fixture-preview-project", parentBranchId: "br-template",
  database: "mille_pr", role: "mille_pr_owner", maxPrBranches: 2 };
const ref = "codex/native/fixture-a";
const peerRef = "codex/native/fixture-b";
const createdAt = "2026-11-21T11:00:00Z";
const notBefore = Date.parse(createdAt);
const template = { id: config.parentBranchId, project_id: config.projectId, name: "mille-pr-template",
  default: true, protected: false, current_state: "ready", parent_id: null as string | null, created_at: createdAt };
const standing = { ...template, id: "br-standing", name: "main", default: false };
const candidate = { ...template, id: "br-native-a", name: `preview/${ref}`, parent_id: template.id, default: false };
const peer = { ...candidate, id: "br-native-b", name: `preview/${peerRef}` };
const db = "neondb";
const role = "neondb_owner";
const secret = "fixture-private-provider-error";

function endpoint(branch: typeof template) {
  const id = branch.id.replace(/^br-/, "ep-");
  return { id, branch_id: branch.id, project_id: config.projectId, host: `${id}.ap-southeast-1.aws.neon.tech`,
    type: "read_write", disabled: false };
}

const { id: candidateEndpoint, host } = endpoint(candidate);
const expected: NativeNeonBranch = { id: candidate.id, endpointId: candidateEndpoint, host };

function scenario(t: TestContext, options: {
  branches?: Array<typeof template>;
  directBranches?: Record<string, typeof template>;
  projectName?: string;
  pagination?: Record<string, unknown>;
  endpoints?: Array<ReturnType<typeof endpoint>>;
  passwords?: Record<string, string>;
  childOwner?: string;
  nonemptyTemplate?: string;
  templateMetadataStatus?: number;
  templateSqlFailureAt?: string;
  templateSqlTransportFailureAt?: string;
  initializeFails?: boolean;
  ownershipCheckFails?: "transport" | "response" | "marker";
  endpointStays?: boolean;
} = {}) {
  let branches = options.branches ?? [template, standing, candidate, peer];
  let computes = options.endpoints ?? branches.map(endpoint);
  const events: string[] = [];
  const passwordReads: string[] = [];
  const inspected: string[] = [];
  const verifyCurrent = async () => { events.push("current"); };
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/sql") {
      const headers = new Headers(init.headers);
      const connection = new URL(headers.get("Neon-Connection-String") ?? "");
      const payload = JSON.parse(String(init.body));
      if (connection.hostname === endpoint(template).host) {
        const database = connection.pathname.slice(1);
        assert.equal(headers.get("Neon-Batch-Read-Only"), "true");
        assert.match(payload.queries[0].query, /pg_largeobject_metadata/);
        inspected.push(database);
        if (options.templateSqlFailureAt === database) return Response.json({ message: secret }, { status: 400 });
        if (options.templateSqlTransportFailureAt === database) throw new Error(secret);
        return Response.json({ results: [{
          fields: [{ name: "database", dataTypeID: 25 }, { name: "role", dataTypeID: 25 }, { name: "empty", dataTypeID: 16 }],
          rows: [[database, role, options.nonemptyTemplate === database ? "f" : "t"]],
        }] });
      }
      assert.equal(connection.hostname, expected.host);
      assert.equal(connection.pathname, `/${db}`);
      assert.equal(connection.username, role);
      if (options.initializeFails) return Response.json({ message: secret }, { status: 400 });
      const query: string = payload.query;
      if (query.startsWith("SELECT project")) {
        if (options.ownershipCheckFails === "transport") throw new Error(secret);
        if (options.ownershipCheckFails === "response") return new Response(secret);
        events.push("marker");
        return Response.json({ fields: ["project", "environment", "environment_id"].map(name => ({ name, dataTypeID: 25 })),
          rows: [["tyask/mille", "preview", options.ownershipCheckFails === "marker" ? "mille-pr-9" : "mille-pr-8"]] });
      }
      assert.match(query, /mille-pr-8/);
      events.push(query.includes("mille_seed") ? "seed" : "migration");
      return Response.json({ fields: [], rows: [] });
    }

    assert.equal(url.origin, "https://console.neon.tech");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${config.apiKey}`);
    const prefix = `/api/v2/projects/${config.projectId}`;
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    if (init.method === "DELETE") {
      assert.equal(path, `/branches/${candidate.id}`);
      assert.equal(events.at(-1), "current");
      events.push("delete");
      branches = branches.filter(item => item.id !== candidate.id);
      if (!options.endpointStays) computes = computes.filter(item => item.branch_id !== candidate.id);
      return Response.json({ branch: candidate, operations: [{ id: "op-delete", action: "delete_timeline",
        branch_id: candidate.id, project_id: config.projectId, status: "finished" }] });
    }
    assert.equal(init.method, "GET");
    if (!path) return Response.json({ project: { id: config.projectId, name: options.projectName ?? "mille-preview" } });
    if (path === "/branches") {
      assert.equal(url.searchParams.get("limit"), "100");
      return Response.json({ branches, pagination: options.pagination });
    }
    if (path === "/endpoints") return Response.json({ endpoints: computes });
    if (path === "/connection_uri") {
      const id = url.searchParams.get("branch_id") ?? "";
      const compute = computes.find(item => item.branch_id === id);
      assert.ok(compute);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        branch_id: id, endpoint_id: compute.id, database_name: db, role_name: role, pooled: "false",
      });
      passwordReads.push(id);
      const password = options.passwords?.[id] ?? `fixture-password-${id}`;
      return Response.json({ uri: `postgresql://${role}:${password}@${compute.host}/${db}?sslmode=require` });
    }
    const [, kind, id, resource] = path.split("/");
    if (kind === "branches") {
      const branch = options.directBranches?.[id] ?? branches.find(item => item.id === id);
      if (!branch) return new Response(null, { status: 404 });
      if (resource === "endpoints") return Response.json({ endpoints: computes.filter(item => item.branch_id === id) });
      if (resource === "databases") {
        return Response.json({ databases: [{ branch_id: id, name: db, owner_name: id === candidate.id ? options.childOwner ?? role : role }] });
      }
      if (resource === "roles") {
        if (id === template.id && options.templateMetadataStatus !== undefined) {
          return Response.json({ message: secret }, { status: options.templateMetadataStatus });
        }
        return Response.json({ roles: [{ branch_id: id, name: role, protected: false }] });
      }
      return Response.json({ branch });
    }
    if (kind === "endpoints") {
      const endpoint = computes.find(item => item.id === id);
      return endpoint ? Response.json({ endpoint }) : new Response(null, { status: 404 });
    }
    assert.fail(`Unknown Neon fixture operation ${path}`);
  });
  return { events, passwordReads, inspected, verifyCurrent };
}

function failureIn(stage: NativePilotStageError["stage"], httpStatus?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof NativePilotStageError);
    assert.equal(error.stage, stage);
    const status = error.cause instanceof NativePilotHttpError ? error.cause.status
      : error.cause instanceof NeonPreviewError ? error.cause.httpStatus : undefined;
    assert.equal(status, httpStatus);
    const diagnostic = formatNativePilotFailure(error, status);
    const loggedStatus = /\(HTTP ([0-9]{3})\)$/.exec(diagnostic)?.[1];
    assert.equal(loggedStatus, httpStatus === undefined ? undefined : String(httpStatus));
    assert.doesNotMatch(`${diagnostic}\n${error.message}`, /fixture-|postgresql:\/\//);
    return true;
  };
}

test("Native 試験は既定テンプレートの空状態と既存の常設接続先を照合する", async t => {
  const fixture = scenario(t);
  await new NeonPreview(config).nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]);
  assert.deepEqual(fixture.inspected, [db, "postgres", "template1"]);
  assert.deepEqual(fixture.passwordReads, [template.id]);
  assert.deepEqual(fixture.events, []);
});

test("常設・既定・テンプレートの空状態が違う場合は Native 試験を拒否する", async t => {
  const service = new NeonPreview(config);
  for (const variation of [
    { projectName: "mille-production" },
    { branches: [{ ...template, default: false }, { ...standing, default: true }] },
    { branches: [template, { ...standing, parent_id: template.id }] },
    { endpoints: [endpoint(template), { ...endpoint(standing), disabled: true }] },
    { branches: [template, standing, { ...candidate, name: "unrelated" }] },
    { branches: [template, standing, { ...candidate, parent_id: standing.id }] },
    { nonemptyTemplate: "postgres" },
  ]) {
    const fixture = scenario(t, variation);
    await assert.rejects(service.nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]));
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
  const fixture = scenario(t);
  await assert.rejects(service.nativePreflight(standing.id, "ep-replaced"), /常設接続先/);
  assert.deepEqual(fixture.passwordReads, []);
});

test("Native 診断はテンプレートのメタデータと読み取り SQL の失敗を区別する", async t => {
  const service = new NeonPreview(config);
  for (const status of [403, 200]) {
    const fixture = scenario(t, { templateMetadataStatus: status });
    await assert.rejects(service.nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]),
      failureIn("neon-template-metadata", status));
    assert.deepEqual(fixture.passwordReads, []);
    assert.deepEqual(fixture.inspected, []);
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
  for (const [options, status] of [
    [{ templateSqlFailureAt: "postgres" }, 400],
    [{ nonemptyTemplate: "postgres" }, 200],
    [{ templateSqlTransportFailureAt: "postgres" }, undefined],
  ] as const) {
    const fixture = scenario(t, options);
    await assert.rejects(service.nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]),
      failureIn("neon-template-sql", status));
    assert.deepEqual(fixture.passwordReads, [template.id]);
    assert.deepEqual(fixture.inspected, [db, "postgres"]);
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
});

test("Native SQL の診断は設定済みの fetch を使い、並行する問い合わせの HTTP 状態を混同しない", async t => {
  const fixture = scenario(t);
  const originalFetch: unknown = neonConfig.fetchFunction;
  t.after(() => { neonConfig.fetchFunction = originalFetch; });
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let sqlRequests = 0;
  const configuredFetch: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/sql");
    assert.equal(new Headers(init?.headers).get("Neon-Batch-Read-Only"), "true");
    if (++sqlRequests === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error(secret);
    }
    return Response.json({ message: secret }, { status: 429 });
  };
  neonConfig.fetchFunction = configuredFetch;

  const service = new NeonPreview(config);
  const first = assert.rejects(service.nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]),
    failureIn("neon-template-sql"));
  await firstStarted.promise;
  try {
    await assert.rejects(service.nativePreflight(standing.id, endpoint(standing).id, [ref, peerRef]),
      failureIn("neon-template-sql", 429));
  } finally {
    releaseFirst.resolve();
    await first;
  }

  assert.equal(sqlRequests, 2);
  assert.deepEqual(fixture.inspected, []);
  assert.deepEqual(fixture.events, []);
});

test("Native の子は正確な Git ブランチ名、作成時刻と直接接続先で識別する", async t => {
  const fixture = scenario(t);
  const service = new NeonPreview(config);
  assert.deepEqual(await service.findNativeBranch(ref, notBefore, notBefore), expected);
  assert.equal(await service.findNativeBranch("codex/not-created"), null);
  await assert.rejects(service.findNativeBranch(ref, notBefore + 1), /作成時刻/);
  await assert.rejects(service.findNativeBranch(ref, notBefore, notBefore - 1), /照合条件/);
  await assert.rejects(service.findNativeBranch("codex/../wrong"), /照合条件/);
  assert.deepEqual(fixture.passwordReads, []);
  assert.deepEqual(fixture.events, []);
});

test("デプロイの READY より後に作成された同名の子を更新・削除しない", async t => {
  const replacement = { ...candidate, id: "br-newer", created_at: "2026-11-21T11:00:01Z" };
  const compute = endpoint(replacement);
  const claimed = { id: replacement.id, endpointId: compute.id, host: compute.host };
  const fixture = scenario(t, { branches: [template, standing, replacement, peer] });
  const service = new NeonPreview(config);
  await assert.rejects(service.findNativeBranch(ref, notBefore, notBefore), /作成時刻/);
  await assert.rejects(service.prepareNativeBranch(ref, claimed, notBefore, 8, standing.id, [peerRef], fixture.verifyCurrent, notBefore),
    /作成時刻/);
  await assert.rejects(service.removeNativeBranch(ref, claimed, notBefore, fixture.verifyCurrent, notBefore), /作成時刻/);
  assert.deepEqual(fixture.passwordReads, []);
  assert.deepEqual(fixture.events, []);
});

test("不完全な一覧、同名の競合、別の親や endpoint を Native 子として採用しない", async t => {
  const service = new NeonPreview(config);
  const branches = [template, standing, candidate, peer];
  for (const variation of [
    { pagination: { cursor: "unseen" } },
    { branches: [...branches, { ...candidate, id: "br-conflict" }] },
    { branches: [template, standing, { ...candidate, parent_id: standing.id }] },
    { branches: [template, standing, { ...candidate, default: true }] },
    { directBranches: { [candidate.id]: { ...candidate, project_id: "fixture-foreign-project" } } },
    { directBranches: { [candidate.id]: { ...candidate, current_state: "init" } } },
    { endpoints: [endpoint(template), endpoint(standing), { ...endpoint(candidate), host: "ep-native-a-pooler.ap-southeast-1.aws.neon.tech" }] },
  ]) {
    const fixture = scenario(t, variation);
    await assert.rejects(service.findNativeBranch(ref, notBefore));
    assert.deepEqual(fixture.passwordReads, []);
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
});

test("子の資格情報の分離と現在の PR を確認してから既存 DB 準備を実行する", async t => {
  const fixture = scenario(t);
  const service = new NeonPreview(config);
  await service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], fixture.verifyCurrent);
  assert.deepEqual(fixture.passwordReads, [candidate.id, template.id, standing.id, peer.id]);
  assert.deepEqual(fixture.events, ["current", "migration", "marker", "seed"]);
});

test("共有資格情報、欠けた比較対象、別ロール、古い PR では DB 処理を拒否する", async t => {
  const service = new NeonPreview(config);
  for (const sharedWith of [template, standing, peer]) {
    const fixture = scenario(t, { passwords: { [candidate.id]: "fixture%2Dshared", [sharedWith.id]: "fixture-shared" } });
    await assert.rejects(service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], fixture.verifyCurrent),
      failureIn("neon-shared-credentials"));
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
  for (const variation of [{ branches: [template, standing, candidate] }, { childOwner: "different_owner" }]) {
    const fixture = scenario(t, variation);
    await assert.rejects(service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], fixture.verifyCurrent));
    assert.deepEqual(fixture.passwordReads, []);
    assert.deepEqual(fixture.events, []);
    t.mock.restoreAll();
  }
  const fixture = scenario(t);
  await assert.rejects(service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], async () => {
    throw new Error("stale PR");
  }), /stale PR/);
  assert.deepEqual(fixture.events, []);
});

test("Native 診断は分離照合と初期化の失敗を区別する", async t => {
  const service = new NeonPreview(config);
  const missing = scenario(t, { branches: [template, standing, candidate] });
  await assert.rejects(service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], missing.verifyCurrent),
    failureIn("neon-isolation"));
  assert.deepEqual(missing.events, []);
  t.mock.restoreAll();

  for (const [options, status, events] of [
    [{ initializeFails: true }, 400, ["current"]],
    [{ ownershipCheckFails: "transport" }, undefined, ["current", "migration"]],
    [{ ownershipCheckFails: "response" }, 200, ["current", "migration"]],
    [{ ownershipCheckFails: "marker" }, 200, ["current", "migration", "marker"]],
  ] as const) {
    const initialization = scenario(t, options);
    await assert.rejects(service.prepareNativeBranch(ref, expected, notBefore, 8, standing.id, [peerRef], initialization.verifyCurrent),
      failureIn("neon-initialize", status));
    assert.deepEqual(initialization.passwordReads, [candidate.id, template.id, standing.id, peer.id]);
    assert.deepEqual(initialization.events, events);
    t.mock.restoreAll();
  }
});

test("Native 子だけを削除し、ブランチと endpoint の不在を再実行でも確認する", async t => {
  const fixture = scenario(t);
  const service = new NeonPreview(config);
  await service.removeNativeBranch(ref, expected, notBefore, fixture.verifyCurrent);
  await service.removeNativeBranch(ref, expected, notBefore, fixture.verifyCurrent);
  assert.deepEqual(fixture.events, ["current", "delete"]);
  assert.equal(await service.findNativeBranch(ref), null);
  assert.equal((await service.findNativeBranch(peerRef))?.id, peer.id);
});

test("Native cleanup は身元が違う資源、孫付きの子、残留した endpoint を成功扱いしない", async t => {
  const service = new NeonPreview(config);
  const fixture = scenario(t, { branches: [template, standing, candidate, { ...peer, parent_id: candidate.id }] });
  await assert.rejects(service.removeNativeBranch(ref, expected, notBefore, fixture.verifyCurrent), /削除対象/);
  await assert.rejects(service.removeNativeBranch(ref, expected, notBefore + 1, fixture.verifyCurrent), /作成時刻/);
  await assert.rejects(service.removeNativeBranch(ref, { ...expected, endpointId: endpoint(peer).id, host: endpoint(peer).host },
    notBefore, fixture.verifyCurrent), /削除対象/);
  assert.deepEqual(fixture.events, []);
  t.mock.restoreAll();

  const linger = scenario(t, { endpointStays: true });
  await assert.rejects(service.removeNativeBranch(ref, expected, notBefore, linger.verifyCurrent), /一覧に残っています/);
  assert.deepEqual(linger.events, ["current", "delete"]);
});
