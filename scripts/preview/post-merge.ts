import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { previewGitHubRequest } from "./github";
import { emptyPostMergeChecks, postMergeChecks, readPostMergeEvidence } from "./post-merge-evidence";
import { postMergeResultSchema, publishPostMerge, type PostMergeResult } from "./post-merge-publish";
import {
  mergedTaskSchema, postMergeNumber, postMergeRepository, postMergeSha, readMergedTask, readPostMergeIssue,
  readPostMergeMain, repositoryIdentity, sameMergedTask, verifyTaskIntent, type MergedTask,
} from "./post-merge-task";
import { resolveMergedPreviewTargets } from "./target";

const resultPath = "post-merge-result.json";
const decimal = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(postMergeNumber);
const push = z.object({ ref: z.literal("refs/heads/main"), after: postMergeSha });
const dispatch = z.object({ inputs: z.object({ pr: decimal }) });

async function context(env: NodeJS.ProcessEnv) {
  const parsed = z.object({
    GITHUB_REPOSITORY: z.literal(postMergeRepository),
    GITHUB_REF: z.literal("refs/heads/main"),
    GITHUB_WORKFLOW_REF: z.literal(`${postMergeRepository}/.github/workflows/post-merge.yml@refs/heads/main`),
    GITHUB_EVENT_NAME: z.enum(["push", "workflow_dispatch"]),
    GITHUB_EVENT_PATH: z.string().min(1),
    GITHUB_SHA: postMergeSha,
    GITHUB_RUN_ID: decimal,
    GITHUB_RUN_ATTEMPT: decimal,
    GH_TOKEN: z.string().min(1),
  }).parse(env);
  const event: unknown = JSON.parse(await readFile(parsed.GITHUB_EVENT_PATH, "utf8"));
  z.object({ repository: repositoryIdentity }).parse(event);
  const bounds = {
    event, read: previewGitHubRequest(parsed.GH_TOKEN), controlSha: parsed.GITHUB_SHA,
    runId: parsed.GITHUB_RUN_ID, attempt: parsed.GITHUB_RUN_ATTEMPT,
  };
  if (parsed.GITHUB_EVENT_NAME === "workflow_dispatch") return { ...bounds, pr: dispatch.parse(event).inputs.pr };
  if (push.parse(event).after !== bounds.controlSha) throw new Error("push の対象 SHA が一致しません。");
  return { ...bounds, pr: undefined };
}

type Context = Awaited<ReturnType<typeof context>>;

async function prepare(env: NodeJS.ProcessEnv, ctx: Context) {
  const { read, event, controlSha, pr } = ctx;
  const targets: MergedTask[] = [];
  if (pr !== undefined) {
    const task = await readMergedTask(read, pr);
    if (!task) throw new Error("案件指定があるマージ済み PR を指定してください。");
    targets.push(task);
  } else {
    for (const preview of await resolveMergedPreviewTargets(event, controlSha, read)) {
      const task = await readMergedTask(read, preview.number);
      if (!task) continue;
      if (task.headSha !== preview.sha) throw new Error("push の PR HEAD が変更されています。");
      targets.push(task);
    }
  }
  await Promise.all(targets.map(task => verifyTaskIntent(read, task)));
  if (!env.GITHUB_OUTPUT) throw new Error("ジョブの出力先がありません。");
  await appendFile(env.GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\n`);
}

async function verify(env: NodeJS.ProcessEnv, ctx: Context, task: MergedTask) {
  const { read, controlSha, runId, attempt } = ctx;
  let result: PostMergeResult = {
    protocol: "mille-post-merge/v1", task, controlSha, runId, attempt,
    checkedAt: new Date().toISOString(), status: "timeout", checks: emptyPostMergeChecks,
  };
  const deadline = Date.now() + 42 * 60_000;
  try {
    await readPostMergeIssue(read, task.metadata.issue);
    while (true) {
      const fresh = await readMergedTask(read, task.number);
      if (!fresh || !sameMergedTask(fresh, task)) throw new Error("案件 PR が変更されています。");
      if (await readPostMergeMain(read) !== task.mergeSha) {
        result.status = "superseded";
        break;
      }
      result.checks = postMergeChecks.parse(await readPostMergeEvidence(task, env));
      if (await readPostMergeMain(read) !== task.mergeSha) {
        result.status = "superseded";
        break;
      }
      const checks = Object.values(result.checks);
      if (checks.some(check => check.status === "failed")) {
        result.status = "failed";
        break;
      }
      if (checks.every(check => check.status === "passed")) {
        result.status = "passed";
        break;
      }
      if (Date.now() >= deadline) break;
      await wait(Math.min(30_000, deadline - Date.now()));
    }
  } catch {
    result = { ...result, status: "failed" };
  }
  result.checkedAt = new Date().toISOString();
  await writeFile(resultPath, `${JSON.stringify(postMergeResultSchema.parse(result), null, 2)}\n`, { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `## マージ後確認\n\nPR #${task.number} / Issue #${task.metadata.issue}\n\nMerge SHA \`${task.mergeSha}\`\n\n結果 \`${result.status}\`\n`);
  }
  if (result.status !== "passed") process.exitCode = 1;
}

async function main(env: NodeJS.ProcessEnv) {
  const mode = z.enum(["prepare", "verify", "publish"]).parse(process.argv[2]);
  const ctx = await context(env);
  if (mode === "prepare") return prepare(env, ctx);
  const task = mergedTaskSchema.parse(JSON.parse(env.MILLE_POST_MERGE_TASK ?? ""));
  if (ctx.pr !== undefined && task.number !== ctx.pr) throw new Error("手動実行の PR が一致しません。");
  if (mode === "verify") return verify(env, ctx, task);

  const file = await lstat(resultPath);
  if (!file.isFile() || file.size > 30_000) throw new Error("マージ後確認の証跡が一致しません。");
  const result = postMergeResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
  if (!sameMergedTask(task, result.task) || result.controlSha !== ctx.controlSha
    || result.runId !== ctx.runId || result.attempt !== ctx.attempt) throw new Error("証跡の試行が一致しません。");
  await publishPostMerge(ctx.read, result);
}

main(process.env).catch(() => {
  console.error("マージ後確認を完了できませんでした。実行したジョブと、保存された証跡を確認してください。");
  process.exitCode = 1;
});
