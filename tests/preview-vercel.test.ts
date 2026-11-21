import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { VercelPreview, type PreviewSourceFile } from "../scripts/preview/vercel";

const projectId = "prj_MillePreview";
const teamId = "team_Mille";
const project = {
  id: projectId, name: "mille", accountId: teamId, link: { type: "github", repoId: 1436928292, productionBranch: "main" },
  framework: "nextjs", nodeVersion: "24.x", autoExposeSystemEnvs: true,
  ssoProtection: { deploymentType: "all_except_custom_domains" },
};
const target = { number: 8, sha: "a".repeat(40) };
const db = {
  expectedHost: "ep-preview.neon.tech",
  connectionString: "postgresql://pr_user:dummy_password@ep-preview.neon.tech/mille?sslmode=require",
};
const files = [{ file: "package.json", data: Buffer.from("{}") }];
const deployment = {
  id: "dpl_MillePreview", projectId, ownerId: teamId, name: project.name, target: null,
  url: "mille-pr-preview-abc123-team.vercel.app", createdAt: 1, public: false,
  readyState: "READY",
  meta: {
    millePreviewProtocol: "mille-pr-preview/v1", millePreviewRepository: "tyask/mille",
    millePreviewPr: String(target.number), millePreviewSha: target.sha,
    millePreviewDbHostHash: createHash("sha256").update(db.expectedHost).digest("hex"),
  },
};
type Detail = Omit<typeof deployment, "target"> & { target: string | null };
type ListEntry = { uid: string; projectId: string; meta?: { millePreviewPr: string } };

function scenario(options: {
  project?: Partial<typeof project> & { protectionBypass?: unknown };
  envs?: Array<{ target: string[]; gitBranch?: string | null }>;
  initial?: Detail[];
  list?: ListEntry[];
  next?: number;
  afterCreate?: Detail;
} = {}) {
  const details = new Map((options.initial ?? []).map((item) => [item.id, item]));
  const methods: string[] = [];
  const creates: Array<Record<string, unknown>> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), teamId);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer dummy-token");
    assert.equal(init?.redirect, "error");
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url.pathname}`);
    if (url.pathname === `/v9/projects/${projectId}`) return Response.json({ ...project, ...options.project });
    if (url.pathname === `/v10/projects/${projectId}/env`) {
      assert.equal(url.searchParams.get("decrypt"), "false");
      return Response.json({ envs: options.envs ?? [] });
    }
    if (url.pathname === "/v6/deployments") {
      assert.equal(url.searchParams.get("projectId"), projectId);
      const items = options.list ?? [...details.values()].map((detail) => ({
        uid: detail.id, projectId: detail.projectId, meta: detail.meta,
      }));
      return Response.json({ deployments: items, pagination: { next: options.next ?? null, count: items.length } });
    }
    if (url.pathname === "/v13/deployments" && method === "POST") {
      assert.equal(url.searchParams.get("forceNew"), "1");
      creates.push(JSON.parse(String(init?.body)));
      details.set(deployment.id, options.afterCreate ?? deployment);
      return Response.json({ id: deployment.id, target: deployment.target });
    }
    const item = details.get(url.pathname.split("/").at(-1) ?? "");
    if (!item) return new Response(null, { status: 404 });
    if (method === "GET") return Response.json(item);
    if (method === "DELETE") {
      details.delete(item.id);
      return Response.json({ uid: item.id, state: "DELETED" });
    }
    assert.fail("未定義の Vercel API リクエストです。");
  };
  return {
    preview: new VercelPreview({ projectId, teamId, token: "dummy-token" }, request),
    methods, creates,
  };
}

test("現在 SHA の専用 Preview を作成し、検証済みの READY URL を返す", async () => {
  const { preview, creates } = scenario();
  let checks = 0;
  assert.deepEqual(await preview.deploy(target, db, files, async () => { checks++; }), {
    id: deployment.id, url: `https://${deployment.url}`,
  });
  assert.ok(checks >= 3);
  assert.equal(creates.length, 1);
  const call = creates[0];
  assert.equal(call.project, projectId);
  assert.equal(call.target, undefined);
  assert.deepEqual(call.meta, deployment.meta);
  assert.deepEqual(call.build, { env: { MILLE_SOURCE_SHA: target.sha } });
  assert.deepEqual(call.files, [{ file: "package.json", data: "e30=", encoding: "base64" }]);
  const env = call.env as Record<string, unknown>;
  assert.equal(env.MILLE_PREVIEW_DATABASE_URL, db.connectionString);
  assert.equal(env.MILLE_PREVIEW_ENVIRONMENT_ID, "mille-pr-8");
  assert.equal(env.AUTH_MODE, "test");
  assert.equal(typeof env.AUTH_SECRET, "string");
  assert.equal(env.VERCEL_TOKEN, undefined);
  assert.equal(env.NEON_API_KEY, undefined);
});

test("同じ SHA・DB の READY Deployment を再利用する", async () => {
  const { preview, creates } = scenario({ initial: [deployment] });
  assert.deepEqual(await preview.deploy(target, db, files), { id: deployment.id, url: `https://${deployment.url}` });
  assert.equal(creates.length, 0);
});

test("既存環境変数、専用プロジェクトの相違、PR の秘密参照を拒否する", async () => {
  for (const options of [{ envs: [{ target: ["preview"] }] }, { project: { name: "other" } }]) {
    const { preview, creates } = scenario(options);
    await assert.rejects(preview.deploy(target, db, files), /環境変数|所有/);
    assert.equal(creates.length, 0);
  }
  const { preview, methods } = scenario();
  const source: PreviewSourceFile[] = [...files, {
    file: "vercel.json", data: Buffer.from('{"build":{"env":{"VALUE":"@shared-secret"}}}'),
  }];
  await assert.rejects(preview.deploy(target, db, source), /vercel.json/);
  assert.equal(methods.length, 0);
});

test("自動化バイパスが設定されているか、状態を判定できないプロジェクトを拒否する", async () => {
  for (const protectionBypass of [
    { "dummy-bypass": { scope: "automation-bypass", isEnvVar: true } },
    { "dummy-bypass": { scope: "automation-bypass" } },
    { "dummy-bypass": { scope: "automation-bypass", isEnvVar: false } },
    { "dummy-bypass": { scope: "integration-automation-bypass" } },
    null,
    [],
  ]) {
    const { preview, creates } = scenario({ project: { protectionBypass } });
    await assert.rejects(preview.deploy(target, db, files), (error: Error) => {
      assert.match(error.message, /バイパス設定/);
      assert.doesNotMatch(error.message, /dummy-bypass/);
      return true;
    });
    assert.equal(creates.length, 0);
  }
  await scenario({ project: { protectionBypass: {} } }).preview.preflight();
});

test("PR が更新されたとき、古い HEAD の URL を返さない", async () => {
  const { preview, creates } = scenario();
  await assert.rejects(preview.deploy(target, db, files, async () => {
    if (creates.length) throw new Error("PR が更新されました。");
  }), /PR が更新/);
});

test("専用 PR の Deployment だけを削除して不在を確認する", async () => {
  const other = { ...deployment, id: "dpl_Other", meta: { ...deployment.meta, millePreviewPr: "9" } };
  const { preview, methods } = scenario({ initial: [deployment, other] });
  await preview.remove(target.number);
  assert.deepEqual(methods.filter((method) => method.startsWith("DELETE")), [`DELETE /v13/deployments/${deployment.id}`]);
  assert.ok(methods.includes(`GET /v13/deployments/${deployment.id}`));
});

test("所有の相違・不完全な一覧・再オープンを検出すると削除しない", async () => {
  for (const options of [
    { initial: [{ ...deployment, ownerId: "team_Other" }] },
    { initial: [{ ...deployment, target: "production" }] },
    { next: 123 },
  ]) {
    const { preview, methods } = scenario(options);
    await assert.rejects(preview.remove(target.number));
    assert.ok(methods.every((method) => !method.startsWith("DELETE")));
  }
  const { preview, methods } = scenario({ initial: [deployment] });
  let checks = 0;
  await assert.rejects(preview.remove(target.number, async () => {
    if (++checks > 1) throw new Error("PR が再オープンされました。");
  }), /再オープン/);
  assert.ok(methods.every((method) => !method.startsWith("DELETE")));
});

test("本番・常設用の変数を維持し、PR に届く共通・個別変数だけを拒否する", async () => {
  const production = { target: ["production"] };
  const standing = { target: ["preview"], gitBranch: "mille-standing-preview" };
  await scenario({ envs: [production, standing] }).preview.preflight();
  for (const gitBranch of [null, "codex/sample", "*"]) {
    await assert.rejects(scenario({ envs: [production, standing, { target: ["preview"], gitBranch }] }).preview.preflight(), /引き継がれる/);
  }
  await assert.rejects(scenario({ project: { link: { ...project.link, repoId: 99 } } }).preview.preflight());
  await assert.rejects(scenario({ project: { link: { ...project.link, productionBranch: "develop" } } }).preview.preflight());
});
