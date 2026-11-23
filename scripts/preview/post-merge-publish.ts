import { z } from "zod";
import type { PreviewGitHubRequest } from "./github";
import { postMergeChecks } from "./post-merge-evidence";
import {
  acceptanceComplete, githubPages, mergedTaskSchema, postMergeNumber, postMergeRepository, postMergeSha,
  readMergedTask, readPostMergeIssue, readPostMergeMain, readTaskMetadata, sameMergedTask, verifyTaskIntent,
  type MergedTask,
} from "./post-merge-task";

export const postMergeResultSchema = z.strictObject({
  protocol: z.literal("mille-post-merge/v1"),
  task: mergedTaskSchema,
  controlSha: postMergeSha,
  runId: postMergeNumber,
  attempt: postMergeNumber,
  checkedAt: z.iso.datetime(),
  status: z.enum(["passed", "failed", "timeout", "superseded"]),
  checks: postMergeChecks,
}).refine(result => {
  const { production, standing, cleanup } = result.checks;
  return (result.status !== "passed" || Object.values(result.checks).every(check => check.status === "passed"))
    && (production.status !== "passed" || production.details.runtimeSha === result.task.mergeSha)
    && (standing.status !== "passed" || standing.details.runtimeSha === result.task.mergeSha)
    && (cleanup.status !== "passed" || cleanup.details.headSha === result.task.headSha);
});
export type PostMergeResult = z.infer<typeof postMergeResultSchema>;

const markerPrefix = "<!-- mille-post-merge/v1 ";
const comment = z.object({
  id: postMergeNumber,
  body: z.string(),
  user: z.object({ id: postMergeNumber, login: z.string(), type: z.string() }).nullable(),
});
type Comment = z.infer<typeof comment>;
const pullRow = z.object({ number: postMergeNumber, body: z.string().nullable(), state: z.enum(["open", "closed"]) });
const closeCandidate = z.object({ number: postMergeNumber, state: z.literal("closed"), merged: z.boolean() });

function byActions(comment: Comment) {
  return comment.user?.id === 41898282 && comment.user.login === "github-actions[bot]" && comment.user.type === "Bot";
}

function readHistory(existing: Comment, issue: number) {
  const header = existing.body.split("\n", 1)[0];
  if (!header.endsWith(" -->")) throw new Error("マージ後確認の履歴を照合できません。");
  const history = z.array(postMergeResultSchema).parse(JSON.parse(header.slice(markerPrefix.length, -4)));
  if (history.some(entry => entry.task.metadata.issue !== issue)
    || new Set(history.map(entry => entry.task.number)).size !== history.length) {
    throw new Error("マージ後確認の履歴が一致しません。");
  }
  return history;
}

function newer(previous: PostMergeResult, current: PostMergeResult) {
  return previous.runId > current.runId || (previous.runId === current.runId && previous.attempt > current.attempt);
}

async function relatedWorkComplete(read: PreviewGitHubRequest, task: MergedTask, history: PostMergeResult[]) {
  const rows = await githubPages(read, "pulls?state=all&base=main", pullRow);
  if (new Set(rows.map(row => row.number)).size !== rows.length) return false;
  const related = new Set<number>();
  for (const row of rows) {
    let info;
    try { info = readTaskMetadata(row.body); } catch { continue; }
    if (info?.issue !== task.metadata.issue) continue;
    if (row.state === "open") return false;
    const pr = closeCandidate.parse(await read(`pulls/${row.number}`));
    if (pr.number !== row.number) return false;
    if (!pr.merged) continue;
    const recorded = history.find(entry => entry.task.number === row.number);
    const actual = await readMergedTask(read, row.number);
    if (recorded?.status !== "passed" || !actual || actual.metadata.manualPostMerge
      || !sameMergedTask(recorded.task, actual)) return false;
    related.add(row.number);
  }
  return related.has(task.number) && history.every(entry => related.has(entry.task.number));
}

const labels = { ci: "main CI", production: "本番とエイリアス", standing: "常設 Preview", cleanup: "PR 専用資源の削除" };
const statusLabel = { passed: "成功", failed: "失敗", timeout: "時間内に確認できず", superseded: "main が更新済み" };

function renderComment(history: PostMergeResult[], current: PostMergeResult) {
  const actions = (entry: PostMergeResult) =>
    `https://github.com/${postMergeRepository}/actions/runs/${entry.runId}/attempts/${entry.attempt}`;
  const lane = (check: PostMergeResult["checks"][keyof PostMergeResult["checks"]]) =>
    check.status === "passed" ? `[成功](${check.url})` : check.status === "failed" ? "失敗" : "確認待ち";
  const rows = [...history].sort((a, b) => a.task.number - b.task.number).map(entry =>
    `| #${entry.task.number} | \`${entry.task.headSha}\` | \`${entry.task.mergeSha}\` | ${lane(entry.checks.ci)} | ${lane(entry.checks.production)} | ${lane(entry.checks.standing)} | ${lane(entry.checks.cleanup)} | ${entry.task.metadata.manualPostMerge ? "必要" : "なし"} | [${statusLabel[entry.status]}](${actions(entry)}) |`);
  const details = Object.entries(current.checks).map(([name, check]) => {
    const label = labels[name as keyof typeof labels];
    return check.status === "passed" ? `- ${label} [証跡](${check.url})` : `- ${label} \`${check.reason}\``;
  });
  const { production, standing, cleanup } = current.checks;
  if (production.status === "passed") {
    details.push(`- 本番デプロイ \`${production.details.deploymentId}\` · ${Object.keys(production.details.aliases).join("、")}`);
  }
  if (standing.status === "passed") {
    const data = standing.details;
    details.push(`- 常設 Preview \`${data.deploymentId}\` · DB \`${data.branchId}\` / \`${data.endpointId}\` · ブラウザ ${data.passedCases}/4 [固定 URL](${data.fixedOrigin})`);
  }
  if (cleanup.status === "passed") {
    details.push(`- Vercel \`${cleanup.details.vercelProjectId}\` と Neon \`${cleanup.details.neonProjectId}\` で PR 資源の不在を確認`);
  }
  return [
    `${markerPrefix}${JSON.stringify(history)} -->`,
    "## マージ後確認",
    "",
    "| PR | PR HEAD | Merge SHA | main CI | 本番 | 常設 Preview | PR 資源削除 | 手動確認 | 結果 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `### PR #${current.task.number} の今回の照合`,
    "",
    ...details,
    "",
    `[実行と JSON 証跡](${actions(current)})`,
  ].join("\n");
}

export async function publishPostMerge(read: PreviewGitHubRequest, result: PostMergeResult): Promise<void> {
  const task = result.task;
  const current = await readMergedTask(read, task.number);
  if (!current || !sameMergedTask(current, task)) throw new Error("PR の案件指定が変更されています。");
  await verifyTaskIntent(read, current);
  const issue = await readPostMergeIssue(read, task.metadata.issue);
  if (await readPostMergeMain(read) !== task.mergeSha) result = { ...result, status: "superseded" };

  const comments = await githubPages(read, `issues/${issue.number}/comments`, comment);
  const owned = comments.filter(item => byActions(item) && item.body.startsWith(markerPrefix));
  if (owned.length > 1) throw new Error("既存のマージ後確認コメントを特定できません。");
  const existing = owned[0];
  const history = existing ? readHistory(existing, issue.number) : [];
  const previous = history.find(entry => entry.task.number === task.number);
  if (previous && previous.task.mergeSha !== task.mergeSha) throw new Error("同じ PR の merge SHA が一致しません。");
  if (previous && newer(previous, result)) return;
  const updated = [...history.filter(entry => entry.task.number !== task.number), result];
  const body = renderComment(updated, result);
  if (body.length > 64_000) throw new Error("マージ後確認コメントが GitHub の上限を超えています。");

  const beforeWrite = await readMergedTask(read, task.number);
  if (!beforeWrite || !sameMergedTask(beforeWrite, task)) throw new Error("PR の案件指定が変更されています。");
  if (!existing) {
    await read(`issues/${issue.number}/comments`, { method: "POST", body: { body } });
  } else if (body !== existing.body) {
    const fresh = comment.parse(await read(`issues/comments/${existing.id}`));
    if (fresh.id !== existing.id || !byActions(fresh) || fresh.body !== existing.body) {
      throw new Error("既存のマージ後確認コメントが変更されています。");
    }
    await read(`issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
  }

  if (result.status !== "passed" || !task.metadata.completesIssue || task.metadata.manualPostMerge
    || issue.state !== "open" || !acceptanceComplete(issue.body) || !(await relatedWorkComplete(read, task, updated))) return;
  const finalIssue = await readPostMergeIssue(read, issue.number);
  const finalTask = await readMergedTask(read, task.number);
  if (finalIssue.state !== "open" || !acceptanceComplete(finalIssue.body)
    || !finalTask || !sameMergedTask(finalTask, task) || await readPostMergeMain(read) !== task.mergeSha) return;
  await read(`issues/${issue.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
}
