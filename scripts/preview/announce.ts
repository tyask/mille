import { previewContext } from "./github";
import { previewNotificationResult, previewNotificationRun, publishPreviewNotification } from "./notification";
import { previewTargetIsCurrent, previewTargetSchema, samePreviewTarget } from "./target";

async function main() {
  const target = previewTargetSchema.parse(JSON.parse(process.env.MILLE_PR_PREVIEW_TARGET ?? ""));
  if (target.operation !== "deploy") throw new Error("通知の対象が deploy ではありません。");
  const context = await previewContext();
  const targets = await context.targets();
  if (!targets.some((value) => samePreviewTarget(value, target))) return;

  const run = previewNotificationRun.parse({
    id: Number(process.env.GITHUB_RUN_ID),
    number: Number(process.env.GITHUB_RUN_NUMBER),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  const stage = process.env.MILLE_PR_PREVIEW_NOTIFICATION;
  if (stage !== "start" && stage !== "result") throw new Error("通知の種類が無効です。");
  const report = stage === "start" ? { state: "pending" as const } : previewNotificationResult(
    target, process.env.MILLE_PR_PREVIEW_RESULT ?? "", process.env.MILLE_PR_PREVIEW_READY ?? "",
  );
  await publishPreviewNotification({
    target, report, run, request: context.request, updatedAt: new Date(),
    isCurrent: () => previewTargetIsCurrent(target, context.read),
  });
}

main().catch(() => {
  console.error("PR Preview の通知を更新できませんでした。");
  process.exitCode = 1;
});
