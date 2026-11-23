import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewGitHubRequest } from "../scripts/preview/github";
import { postMergeResultSchema, publishPostMerge, type PostMergeResult } from "../scripts/preview/post-merge-publish";
import { acceptanceComplete, readTaskMetadata, type MergedTask } from "../scripts/preview/post-merge-task";

const task: MergedTask = {
  number: 70, headSha: "a".repeat(40), headRef: "codex/issue-32-post-merge", mergeSha: "b".repeat(40),
  mergedAt: "2026-11-23T01:00:00Z",
  metadata: { issue: 32, intent: "aidlc/spaces/default/intents/261123-post-merge", completesIssue: true, manualPostMerge: false },
};
const repo = { id: 1436928292, full_name: "tyask/mille" };
const actions = "https://github.com/tyask/mille/actions/runs/92";
const fixedOrigin = "https://mille-main-preview-fumin1.vercel.app";
const production = "dpl_prod";
const result: PostMergeResult = {
  protocol: "mille-post-merge/v1", task, controlSha: task.mergeSha, runId: 96, attempt: 1,
  checkedAt: "2026-11-23T01:08:00Z", status: "passed",
  checks: {
    ci: { status: "passed", url: `${actions}/attempts/1`, details: { runId: 92, attempt: 1, jobId: 106 } },
    production: { status: "passed", url: "https://mille-hazel.vercel.app", details: {
      deploymentId: production, runtimeSha: task.mergeSha, aliases: {
        "mille-hazel.vercel.app": production, "mille-fumin1.vercel.app": production, "mille-git-main-fumin1.vercel.app": production,
      },
    } },
    standing: { status: "passed", url: `${actions}/artifacts/7`, details: {
      runId: 92, attempt: 1, artifactId: 7, deploymentId: "dpl_standing", aliasId: "alias1", fixedOrigin,
      origin: "https://immutable-fumin1.vercel.app", dbProjectId: "mille-project", branchId: "br-standing",
      endpointId: "ep-standing", runtimeSha: task.mergeSha, passedCases: 4,
    } },
    cleanup: { status: "passed", url: `${actions}/job/9`, details: {
      runId: 92, attempt: 1, jobId: 9, vercelProjectId: "prj_mille", neonProjectId: "mille-project", headSha: task.headSha,
    } },
  },
};
const checked = "## 受入条件\n\n- [x] AC-01: 照合済み\n\n## 進捗\n";
const marker = (metadata: MergedTask["metadata"]) => `<!-- mille-task/v1 ${JSON.stringify(metadata)} -->`;
const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };

function fixture({ current = task, issueBody = checked, openRelated = false, malformedRelated = false, mainBefore = task.mergeSha,
  mainBeforeClose = task.mergeSha, priorResult, latePrChange = false, frozenMetadata = current.metadata,
  addedIntent = true, verifiedRun = true }: {
  current?: MergedTask; issueBody?: string; openRelated?: boolean; malformedRelated?: boolean;
  mainBefore?: string; mainBeforeClose?: string; priorResult?: PostMergeResult; latePrChange?: boolean;
  frozenMetadata?: MergedTask["metadata"]; addedIntent?: boolean; verifiedRun?: boolean;
} = {}) {
  const mutations: { path: string; request: NonNullable<Parameters<PreviewGitHubRequest>[1]> }[] = [];
  let mainReads = 0;
  let prReads = 0;
  const body = marker(current.metadata);
  const pathToIntent = `${current.metadata.intent}/intent.json`;
  const intentBlob = "d".repeat(40);
  const comments = priorResult ? [{ id: 80, body: `<!-- mille-post-merge/v1 ${JSON.stringify([priorResult])} -->\n`, user: bot }] : [];
  const read: PreviewGitHubRequest = async (path, request) => {
    if (request) {
      mutations.push({ path, request });
      return {};
    }
    if (path === `pulls/${current.number}`) {
      prReads++;
      return { number: current.number, body: latePrChange && prReads > 1 ? null : body, state: "closed",
        merged: true, merged_at: current.mergedAt, merge_commit_sha: current.mergeSha, author_association: "OWNER",
        head: { ref: current.headRef, sha: current.headSha, repo }, base: { ref: "main", repo } };
    }
    if (path === `contents/${pathToIntent}?ref=${current.mergeSha}`) {
      return { path: pathToIntent, sha: intentBlob, type: "file", encoding: "base64",
        content: Buffer.from(JSON.stringify({ issue: "https://github.com/tyask/mille/issues/32", branch: current.headRef, state: "frozen",
          postMerge: { completesIssue: frozenMetadata.completesIssue, manualPostMerge: frozenMetadata.manualPostMerge },
        })).toString("base64") };
    }
    if (path === `pulls/${current.number}/files?per_page=100&page=1`) {
      return [{ filename: pathToIntent, sha: intentBlob, status: addedIntent ? "added" : "modified" }];
    }
    if (path === "issues/32") return { number: 32, state: "open", body: issueBody };
    if (path === "branches/main") return { name: "main", commit: { sha: mainReads++ === 0 ? mainBefore : mainBeforeClose } };
    if (path === "issues/32/comments?per_page=100&page=1") return comments;
    if (path === "issues/comments/80") return comments[0];
    if (path === "actions/runs/96/attempts/1") {
      return { id: 96, run_attempt: 1, path: verifiedRun ? ".github/workflows/post-merge.yml" : ".github/workflows/other.yml",
        head_sha: current.mergeSha, head_branch: "main", event: "push", repository: repo, head_repository: repo };
    }
    if (path === "actions/runs/96/attempts/1/jobs?per_page=100") {
      return { total_count: 1, jobs: [{ name: `PR ${current.number} post-merge verification`, status: "completed", conclusion: "success",
        run_id: 96, run_attempt: 1, head_sha: current.mergeSha,
        steps: [{ name: "main CI・本番・常設 Preview・PR 資源削除の照合", status: "completed", conclusion: "success" }],
      }] };
    }
    if (path === "pulls?state=all&base=main&per_page=100&page=1") {
      const rows = [{ number: current.number, body, state: "closed" }];
      if (openRelated) rows.push({ number: 71, body, state: "open" });
      if (malformedRelated) rows.push({ number: 72, body: '<!-- mille-task/v1 {"issue":32', state: "open" });
      return rows;
    }
    throw new Error(`Unexpected path ${path}`);
  };
  return { read, mutations };
}

test("案件の指定を1つの構造化された行として照合する", () => {
  assert.deepEqual(readTaskMetadata(`説明。\r\n${marker(task.metadata)}\r\n`), task.metadata);
  assert.equal(readTaskMetadata("関連 Issue #32"), undefined);
  assert.throws(() => readTaskMetadata(`${marker(task.metadata)}\n${marker(task.metadata)}`));
  assert.throws(() => readTaskMetadata(`説明。${marker(task.metadata)}`));
  assert.throws(() => readTaskMetadata(marker({ ...task.metadata, intent: "../different" })));
});

test("受入条件すべてのチェックと一意な識別子を要求する", () => {
  assert.equal(acceptanceComplete(checked), true);
  assert.equal(acceptanceComplete(checked.replace("[x]", "[ ]")), false);
  assert.equal(acceptanceComplete(checked.replace("## 進捗", "- [x] AC-01: 重複\n\n## 進捗")), false);
  assert.equal(acceptanceComplete("- [x] AC-01: 照合済み"), false);
});

test("検証結果の PR HEAD と merge SHA の食い違いを拒否する", () => {
  assert.deepEqual(postMergeResultSchema.parse(result), result);
  assert.equal(postMergeResultSchema.safeParse({ ...result, task: { ...task, headSha: "c".repeat(40) } }).success, false);
  assert.equal(postMergeResultSchema.safeParse({ ...result, task: { ...task, mergeSha: "c".repeat(40) } }).success, false);
  assert.equal(postMergeResultSchema.safeParse({ ...result, controlSha: "c".repeat(40) }).success, false);
});

test("マージ後の4件の根拠を Issue に記録してから完了する", async () => {
  const sample = fixture();
  await publishPostMerge(sample.read, result);
  assert.equal(sample.mutations.length, 2);
  assert.equal(sample.mutations[0].path, "issues/32/comments");
  assert.match(String(sample.mutations[0].request.body.body), /PR 専用資源の削除/);
  assert.deepEqual(sample.mutations[1], { path: "issues/32", request: { method: "PATCH", body: { state: "closed", state_reason: "completed" } } });
});

test("未完了の関連 PR・受入条件・手動確認・main 更新は Issue を開いたままにする", async () => {
  const manual = { ...task, metadata: { ...task.metadata, manualPostMerge: true } };
  const partial = { ...task, metadata: { ...task.metadata, completesIssue: false } };
  for (const [settings, next] of [
    [{ openRelated: true }, result],
    [{ malformedRelated: true }, result],
    [{ issueBody: checked.replace("[x]", "[ ]") }, result],
    [{ mainBeforeClose: "c".repeat(40) }, result],
    [{ verifiedRun: false }, result],
    [{ current: manual }, { ...result, task: manual }],
    [{ current: partial }, { ...result, task: partial }],
  ] as const) {
    const sample = fixture(settings);
    await publishPostMerge(sample.read, next);
    assert.deepEqual(sample.mutations.map(request => request.path), ["issues/32/comments"]);
  }
});

test("新しい試行が保存済みの場合、古い試行は既存コメントを更新しない", async () => {
  const sample = fixture({ priorResult: { ...result, attempt: 2 } });
  await publishPostMerge(sample.read, result);
  assert.deepEqual(sample.mutations, []);
});

test("書き込み前に PR の案件指定を再確認する", async () => {
  const sample = fixture({ latePrChange: true });
  await assert.rejects(publishPostMerge(sample.read, result), /PR の案件指定が変更/);
  assert.deepEqual(sample.mutations, []);
});

test("マージ済みの Intent を流用した完了指定や、後から編集した完了指定を拒否する", async () => {
  for (const settings of [{ addedIntent: false }, { frozenMetadata: { ...task.metadata, completesIssue: false } }]) {
    const sample = fixture(settings);
    await assert.rejects(publishPostMerge(sample.read, result), /Intent.*照合|Intent.*一致/);
    assert.deepEqual(sample.mutations, []);
  }
});

test("main 更新後の再実行で、同じ案件の過去の成功証跡を失わない", async () => {
  const sample = fixture({ mainBefore: "c".repeat(40), priorResult: result });
  await publishPostMerge(sample.read, { ...result, runId: result.runId + 1, status: "superseded" });
  assert.deepEqual(sample.mutations, []);
});

test("検証が完了してから main が進んだ場合は、観測済みの成功を記録する", async () => {
  const sample = fixture({ mainBefore: "c".repeat(40) });
  await publishPostMerge(sample.read, result);
  assert.deepEqual(sample.mutations.map(request => request.path), ["issues/32/comments"]);
  assert.match(String(sample.mutations[0].request.body.body), /\[成功\]\(https:\/\/github.com\/tyask\/mille\/actions\/runs\/96\/attempts\/1\)/);
});
