import { z } from "zod";
import type { PreviewGitHubRequest } from "./github";
import type { PreviewTarget } from "./target";

type DeployTarget = Extract<PreviewTarget, { operation: "deploy" }>;
const positive = z.number().int().positive();
export const previewNotificationRun = z.object({ id: positive, number: positive, attempt: positive });
const readyReceipt = z.object({
  number: positive,
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  deployment: z.object({
    id: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
    url: z.string().regex(/^https:\/\/[a-z0-9-]+\.vercel\.app$/),
  }),
});
type NotificationReport = { state: "pending" | "failure" | "skipped" }
  | { state: "success"; deployment: z.infer<typeof readyReceipt>["deployment"] };

export function previewNotificationResult(target: DeployTarget, result: string, output: string): NotificationReport {
  if (result === "skipped") return { state: "skipped" };
  if (result !== "success" || !output) return { state: "failure" };
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { return { state: "failure" }; }
  const receipt = readyReceipt.safeParse(value);
  if (!receipt.success || receipt.data.number !== target.number || receipt.data.sha !== target.sha) {
    return { state: "failure" };
  }
  return { state: "success", deployment: receipt.data.deployment };
}

const commentPage = z.array(z.object({
  id: positive,
  body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
})).max(100);
const markerPrefix = "<!-- mille-pr-preview:v1 ";
const markerPattern = /^<!-- mille-pr-preview:v1 ([1-9][0-9]*) ([1-9][0-9]*) (pending|terminal) -->\r?\n/;

async function findNotificationComment(request: PreviewGitHubRequest, pr: number) {
  let result: z.infer<typeof commentPage>[number] | undefined;
  for (let page = 1; page <= 100; page++) {
    const comments = commentPage.parse(await request(`issues/${pr}/comments?per_page=100&page=${page}`));
    for (const comment of comments) {
      if (comment.user?.login !== "github-actions[bot]" || comment.user.type !== "Bot"
        || !comment.body?.startsWith(markerPrefix)) continue;
      if (result) throw new Error("PR Preview の通知コメントが複数あります。");
      result = comment;
    }
    if (comments.length < 100) return result;
  }
  throw new Error("PR のコメントを最後まで確認できません。");
}

const timestamp = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const messages = {
  pending: { label: "Building", state: "pending", description: "Preview を作成中です" },
  failure: { label: "Error", state: "failure", description: "Preview の作成を確認できませんでした" },
  skipped: { label: "Skipped", state: "error", description: "Preview の作成がスキップされました" },
  success: { label: "Ready", state: "success", description: "現在のコミットの Preview が利用可能です" },
};

export async function publishPreviewNotification({ target, report, run, request, isCurrent, updatedAt }: {
  target: DeployTarget;
  report: NotificationReport;
  run: z.infer<typeof previewNotificationRun>;
  request: PreviewGitHubRequest;
  isCurrent: () => Promise<boolean>;
  updatedAt: Date;
}): Promise<void> {
  const phase = report.state === "pending" ? "pending" : "terminal";
  const existing = await findNotificationComment(request, target.number);
  if (existing) {
    const match = markerPattern.exec(existing.body ?? "");
    if (!match) throw new Error("既存の PR Preview 通知の識別情報を確認できません。");
    const [, numberText, attemptText, previousPhase] = match;
    const number = positive.parse(Number(numberText));
    const attempt = positive.parse(Number(attemptText));
    if (number > run.number || (number === run.number && (attempt > run.attempt
      || (attempt === run.attempt && previousPhase === "terminal" && phase === "pending")))) return;
  }

  const project = "https://vercel.com/fumin1/mille";
  const actions = `https://github.com/tyask/mille/actions/runs/${run.id}/attempts/${run.attempt}`;
  const message = messages[report.state];
  const deployment = report.state === "success" ? `[Ready](${project}/${report.deployment.id})` : message.label;
  const link = report.state === "success" ? `[Preview](${report.deployment.url})` : `[Details](${actions})`;
  const body = [
    `${markerPrefix}${run.number} ${run.attempt} ${phase} -->`,
    "| Project | Deployment | Actions | Updated |",
    "| :--- | :--- | :--- | :--- |",
    `| [mille](${project}) | ${deployment} | ${link} | ${timestamp.format(updatedAt)} JST |`,
    "",
    `対象コミット [\`${target.sha.slice(0, 12)}\`](https://github.com/tyask/mille/commit/${target.sha})`,
  ].join("\n");

  // Record the run order before publishing the SHA status, also when a later API call fails.
  if (!await isCurrent()) return;
  const commentPath = existing ? `issues/comments/${existing.id}` : `issues/${target.number}/comments`;
  await request(commentPath, { method: existing ? "PATCH" : "POST", body: { body } });
  if (!await isCurrent()) return;
  await request(`statuses/${target.sha}`, {
    method: "POST",
    body: {
      context: "mille / Preview",
      state: message.state,
      description: message.description,
      target_url: report.state === "success" ? `${project}/${report.deployment.id}` : actions,
    },
  });
}
