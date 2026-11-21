import assert from "node:assert/strict";
import test from "node:test";
import { previewNotificationResult, publishPreviewNotification } from "../scripts/preview/notification";

type Notification = Parameters<typeof publishPreviewNotification>[0];
type Mutation = NonNullable<Parameters<Notification["request"]>[1]>;
type Comment = { id: number; body: string; user: { login: string; type: string } };

const target = { number: 26, sha: "a".repeat(40), operation: "deploy" } as const;
const run = { id: 4501, number: 42, attempt: 2 };
const updatedAt = new Date("2026-11-21T03:00:00.000Z");
const deployment = { id: "dpl_MillePreview", url: "https://mille-preview-example-fumin1.vercel.app" };
const actionsUrl = `https://github.com/tyask/mille/actions/runs/${run.id}/attempts/${run.attempt}`;
const commentsPath = `issues/${target.number}/comments`;
const statusPath = `statuses/${target.sha}`;
const bot = { login: "github-actions[bot]", type: "Bot" };

function comment(id: number, stamp: string, user = bot): Comment {
  return { id, user, body: `<!-- mille-pr-preview:v1 ${stamp} -->\n[Preview](${deployment.url})` };
}

function scenario(existing: Comment[] = []) {
  const comments = [...existing];
  const requests: string[] = [];
  const writes: Array<Mutation & { path: string }> = [];
  const state: { current: boolean; afterRequest?: (path: string) => void } = { current: true };
  const request: Notification["request"] = async (path, mutation) => {
    requests.push(path);
    state.afterRequest?.(path);
    if (!mutation) {
      const url = new URL(path, "https://api.github.com/");
      assert.equal(url.pathname, `/${commentsPath}`);
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page"));
      assert.ok(Number.isSafeInteger(page) && page > 0, path);
      return comments.slice((page - 1) * 100, page * 100);
    }
    writes.push({ path, ...mutation });
    if (path === statusPath) return {};
    const body = mutation.body.body;
    assert.ok(typeof body === "string");
    if (path === commentsPath) {
      assert.equal(mutation.method, "POST");
      const posted = { id: 1000, body, user: bot };
      comments.push(posted);
      return posted;
    }
    assert.equal(mutation.method, "PATCH");
    const index = comments.findIndex(({ id }) => path === `issues/comments/${id}`);
    assert.ok(index >= 0, path);
    comments[index] = { ...comments[index], body };
    return comments[index];
  };
  return {
    comments, requests, writes, state,
    publish: (report: Notification["report"], publicationRun = run) => publishPreviewNotification({
      target, report, run: publicationRun, request, isCurrent: async () => state.current, updatedAt,
    }),
  };
}

test("作成中の表と現行 SHA のステータスを作り、READY で同じコメントを更新する", async () => {
  const { publish, comments, writes } = scenario();
  await publish({ state: "pending" });

  assert.deepEqual(writes.map(({ method, path }) => [method, path]), [
    ["POST", commentsPath], ["POST", statusPath],
  ]);
  assert.equal(writes[1].body.context, "mille / Preview");
  assert.equal(writes[1].body.state, "pending");
  assert.equal(writes[1].body.target_url, actionsUrl);
  assert.match(comments[0].body, /^<!-- mille-pr-preview:v1 42 2 pending -->/);
  assert.match(comments[0].body, /\| Project \| Deployment \| Actions \| Updated \|/);
  assert.match(comments[0].body, /Building/);
  assert.match(comments[0].body, /2026\/11\/21 12:00 JST/);
  assert.ok(comments[0].body.includes(`[Details](${actionsUrl})`));
  assert.ok(!comments[0].body.includes(deployment.url));

  await publish({ state: "success", deployment });

  assert.equal(comments.length, 1);
  assert.deepEqual(writes.slice(2).map(({ method, path }) => [method, path]), [
    ["PATCH", "issues/comments/1000"], ["POST", statusPath],
  ]);
  assert.equal(writes[3].body.context, "mille / Preview");
  assert.equal(writes[3].body.state, "success");
  assert.match(String(writes[3].body.target_url), /^https:\/\/vercel\.com\/fumin1\/mille\/(?:dpl_)?MillePreview$/);
  assert.match(comments[0].body, /^<!-- mille-pr-preview:v1 42 2 terminal -->/);
  assert.match(comments[0].body, /\[Ready\]\(https:\/\/vercel\.com\/fumin1\/mille\/(?:dpl_)?MillePreview\)/);
  assert.ok(comments[0].body.includes(`[Preview](${deployment.url})`));
});

test("コメント一覧の取得後に HEAD が変わると両方の書き込みを行わない", async () => {
  const { publish, state, writes } = scenario();
  state.afterRequest = (path) => {
    if (path.startsWith(`${commentsPath}?`)) state.current = false;
  };
  await publish({ state: "pending" });
  assert.deepEqual(writes, []);
});

test("コメントの更新後に HEAD が変わるとステータスを書き込まない", async () => {
  const existing = comment(11, "42 2 pending");
  const { publish, state, writes } = scenario([existing]);
  state.afterRequest = (path) => {
    if (path === `issues/comments/${existing.id}`) state.current = false;
  };
  await publish({ state: "success", deployment });
  assert.deepEqual(writes.map(({ method, path }) => [method, path]), [["PATCH", "issues/comments/11"]]);
});

test("古い実行や attempt、および終了済み attempt の開始通知は既存の通知を上書きしない", async () => {
  for (const [stamp, state] of [
    ["43 1 pending", "failure"], ["42 3 pending", "failure"], ["42 2 terminal", "pending"],
  ] as const) {
    const existing = comment(11, stamp);
    const { publish, comments, writes } = scenario([existing]);
    await publish({ state });
    assert.deepEqual(writes, [], stamp);
    assert.deepEqual(comments, [existing], stamp);
  }
});

test("人が同じマーカーを書いたコメントは更新せず、次ページの公式コメントを更新する", async () => {
  const lookalike = comment(1, "99 1 terminal", { login: "reviewer", type: "User" });
  const firstPage = [lookalike, ...Array.from({ length: 99 }, (_, index) => ({
    id: index + 2, body: "レビューコメント", user: lookalike.user,
  }))];
  const existing = comment(101, "41 1 terminal");
  const { publish, comments, requests, writes } = scenario([...firstPage, existing]);
  await publish({ state: "success", deployment });

  assert.deepEqual(requests.slice(0, 2), [
    `${commentsPath}?per_page=100&page=1`, `${commentsPath}?per_page=100&page=2`,
  ]);
  assert.equal(writes[0].path, "issues/comments/101");
  assert.equal(writes[0].method, "PATCH");
  assert.deepEqual(comments.slice(0, 100), firstPage);
  assert.equal(comments.length, 101);
});

test("失敗または停止の通知は Actions へ案内し、前の READY URL を載せない", async () => {
  for (const [state, label, status] of [
    ["failure", "Error", "failure"], ["skipped", "Skipped", "error"],
  ] as const) {
    const { publish, comments, writes } = scenario([comment(11, "41 1 terminal")]);
    await publish({ state });
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.includes(label));
    assert.ok(comments[0].body.includes(`[Details](${actionsUrl})`));
    assert.ok(!comments[0].body.includes(deployment.url));
    assert.equal(writes[1].body.state, status);
    assert.equal(writes[1].body.target_url, actionsUrl);
  }
});

test("管理ジョブが現行 PR と SHA の READY 証跡を返した成功だけを通知する", () => {
  const receipt = { number: target.number, sha: target.sha, deployment };
  assert.deepEqual(previewNotificationResult(target, "success", JSON.stringify(receipt)), {
    state: "success", deployment,
  });
  for (const output of [
    "", "{", JSON.stringify({ ...receipt, number: target.number + 1 }),
    JSON.stringify({ ...receipt, sha: "b".repeat(40) }),
    JSON.stringify({ ...receipt, deployment: { ...deployment, url: `${deployment.url}.example.org` } }),
  ]) {
    assert.deepEqual(previewNotificationResult(target, "success", output), { state: "failure" }, output);
  }
  assert.deepEqual(previewNotificationResult(target, "failure", JSON.stringify(receipt)), { state: "failure" });
  assert.deepEqual(previewNotificationResult(target, "skipped", ""), { state: "skipped" });
});
