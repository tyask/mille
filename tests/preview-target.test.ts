import assert from "node:assert/strict";
import test from "node:test";
import {
  previewTargetIsCurrent, resolveManualCleanup, resolveMergedPreviewTargets, resolvePreviewTarget,
} from "../scripts/preview/target";

const head = "a".repeat(40);
const control = "b".repeat(40);
const blob = "c".repeat(40);
const previous = "d".repeat(40);
const merged = "e".repeat(40);
const timestamp = "2026-11-20T00:00:00Z";
const repo = { id: 1, full_name: "tyask/mille" };
const branch = { ref: "codex/sample", sha: head, repo };
const workflowPath = ".github/workflows/pr-events.yml";
const association = { number: 8, head: branch, base: { ref: "main", repo } };
const run = {
  id: 4, workflow_id: 2, run_attempt: 1, event: "pull_request", path: workflowPath,
  status: "completed", conclusion: "success", repository: repo, head_repository: repo,
  head_branch: branch.ref, head_sha: head, display_title: "PR event opened 8", created_at: timestamp,
  pull_requests: [association],
};
const pr = {
  number: 8, state: "open", closed_at: null as string | null,
  merged: false, merge_commit_sha: null as string | null,
  head: branch, base: { ref: "main", sha: control, repo },
};
const closed = { state: "closed", closed_at: timestamp };
const cleanup = { number: 8, sha: head, operation: "cleanup", closedAt: timestamp } as const;

function readFrom(responses: Record<string, unknown>) {
  return async (path: string) => {
    assert.ok(Object.hasOwn(responses, path), path);
    return responses[path];
  };
}

function resolve(options: {
  notification?: Partial<typeof run>;
  apiRun?: Partial<typeof run>;
  apiPR?: Partial<typeof pr>;
  headBlob?: string;
  latest?: typeof run[];
} = {}) {
  const apiRun = { ...run, ...options.apiRun };
  const latest = options.latest ?? [apiRun];
  const read = readFrom({
    "actions/workflows/pr-events.yml": { id: 2, path: workflowPath, state: "active" },
    "actions/runs/4": apiRun,
    "actions/workflows/pr-events.yml/runs?branch=codex%2Fsample&event=pull_request&per_page=100": {
      total_count: latest.length, workflow_runs: latest,
    },
    "pulls/8": { ...pr, ...options.apiPR },
    [`contents/${workflowPath}?ref=${head}`]: { sha: options.headBlob ?? blob, type: "file" },
    [`contents/${workflowPath}?ref=${control}`]: { sha: blob, type: "file" },
    [`contents/${workflowPath}?ref=${merged}`]: { sha: blob, type: "file" },
  });
  return resolvePreviewTarget({
    action: "completed", repository: repo, workflow_run: { ...run, ...options.notification },
  }, control, read);
}

test("現在の HEAD の PR のみ deploy 対象とする", async () => {
  assert.deepEqual(await resolve(), { number: 8, sha: head, operation: "deploy" });
  assert.equal(await resolve({ apiPR: { head: { ...branch, sha: control } } }), null);
  assert.equal(await resolve({ apiPR: { head: { ...branch, repo: { ...repo, id: 42 } } } }), null);
  assert.equal(await resolve({ apiRun: { run_attempt: 2 } }), null);
  assert.equal(await resolve({ apiRun: { workflow_id: 99 } }), null);
  assert.equal(await resolve({ headBlob: control }), null);
  assert.equal(await resolve({ apiRun: { pull_requests: [{ ...association, number: 9 }] } }), null);
});

test("現在も閉じている PR の close 通知のみ cleanup 対象とする", async () => {
  const close = { display_title: "PR event closed 8", pull_requests: [] };
  assert.deepEqual(await resolve({ notification: close, apiRun: close, apiPR: closed }), cleanup);
  const mergeRun = { ...close, head_sha: merged };
  assert.deepEqual(await resolve({
    notification: mergeRun, apiRun: mergeRun,
    apiPR: { ...closed, merged: true, merge_commit_sha: merged },
  }), cleanup);
  assert.equal(await resolve({ notification: close, apiRun: close }), null);
  assert.equal(await resolve({ apiPR: closed }), null);
});

test("同じ HEAD でも新しい通知があれば過去の close を対象外にする", async () => {
  const oldClose = { ...run, display_title: "PR event closed 8" };
  assert.equal(await resolve({
    notification: oldClose, apiRun: oldClose, apiPR: closed,
    latest: [{ ...oldClose, id: 5 }, oldClose],
  }), null);
  assert.equal(await resolve({
    notification: oldClose, apiRun: oldClose,
    apiPR: { ...closed, closed_at: "2026-11-20T00:00:01Z" },
  }), null);
});

test("処理直前に同じリポジトリ、HEAD、PR 状態を再照合できる", async () => {
  const expected = { number: 8, sha: head, operation: "deploy" } as const;
  assert.equal(await previewTargetIsCurrent(expected, readFrom({ "pulls/8": pr })), true);
  assert.equal(await previewTargetIsCurrent(expected, readFrom({ "pulls/8": { ...pr, ...closed } })), false);
  assert.equal(await previewTargetIsCurrent(expected, readFrom({ "pulls/8": { ...pr, number: 9 } })), false);
  assert.equal(await previewTargetIsCurrent(cleanup, readFrom({ "pulls/8": { ...pr, ...closed } })), true);
  assert.equal(await previewTargetIsCurrent(cleanup, readFrom({
    "pulls/8": { ...pr, ...closed, closed_at: "2026-11-20T00:00:01Z" },
  })), false);
});

test("手動 cleanup は同じ PR と SHA の現在の終了状態を要求する", async () => {
  const event = { repository: repo, inputs: { pr: "8", sha: head } };
  const read = readFrom({ "pulls/8": { ...pr, ...closed } });
  assert.deepEqual(await resolveManualCleanup(event, read), cleanup);
  assert.equal(await resolveManualCleanup({ ...event, inputs: { pr: "8", sha: control } }, read), null);
  assert.equal(await resolveManualCleanup(event, readFrom({ "pulls/8": pr })), null);
  assert.equal(await resolveManualCleanup({ ...event, repository: { ...repo, id: 9 } }, read), null);
});

const pushEvent = {
  ref: "refs/heads/main", before: previous, after: control, repository: repo,
  created: false, deleted: false, forced: false,
};
const comparePath = `compare/${previous}...${control}?per_page=100`;
const commitComparison = {
  status: "ahead", total_commits: 2,
  merge_base_commit: { sha: previous }, commits: [{ sha: merged }, { sha: control }],
};

test("main の push から到達したマージで対象の PR 専用資源を選ぶ", async () => {
  const read = readFrom({
    [comparePath]: commitComparison,
    [`commits/${merged}/pulls?per_page=100`]: [
      { number: 8, merge_commit_sha: merged }, { number: 9, merge_commit_sha: null },
    ],
    [`commits/${control}/pulls?per_page=100`]: [{ number: 10, merge_commit_sha: control }],
    "pulls/8": { ...pr, ...closed, merged: true, merge_commit_sha: merged },
    "pulls/10": {
      ...pr, ...closed, merged: true, merge_commit_sha: control, number: 10,
      head: { ...branch, ref: "feature/foreign" },
    },
  });
  assert.deepEqual(await resolveMergedPreviewTargets(pushEvent, control, read), [cleanup]);
});

test("マージ履歴が不完全な場合は cleanup を開始しない", async () => {
  assert.deepEqual(await resolveMergedPreviewTargets({ ...pushEvent, forced: true }, control, readFrom({})), []);
  assert.deepEqual(await resolveMergedPreviewTargets({ ...pushEvent, after: previous }, previous, readFrom({})), []);
  await assert.rejects(resolveMergedPreviewTargets(pushEvent, control, readFrom({
    [comparePath]: { ...commitComparison, total_commits: 101 },
  })), /全コミット/);
  await assert.rejects(resolveMergedPreviewTargets(pushEvent, control, readFrom({
    [comparePath]: commitComparison,
    [`commits/${merged}/pulls?per_page=100`]: [],
    [`commits/${control}/pulls?per_page=100`]: Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, merge_commit_sha: control,
    })),
  })), /全 PR/);
});

test("main の更新で一度に処理する cleanup 対象を 10 件に制限する", async () => {
  const commits = [...Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(40)), control];
  const responses: Record<string, unknown> = {
    [comparePath]: { ...commitComparison, total_commits: commits.length, commits: commits.map((sha) => ({ sha })) },
  };
  for (const [index, commit] of commits.entries()) {
    const number = index + 1;
    responses[`commits/${commit}/pulls?per_page=100`] = [{ number, merge_commit_sha: commit }];
    responses[`pulls/${number}`] = { ...pr, ...closed, merged: true, merge_commit_sha: commit, number };
  }
  await assert.rejects(resolveMergedPreviewTargets(pushEvent, control, readFrom(responses)), /10 件/);
});
