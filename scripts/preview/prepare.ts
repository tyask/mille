import { appendFile } from "node:fs/promises";
import { previewContext } from "./github";
import { nativePilotPrs, selectPreviewWork } from "./native-pilot-selection";

async function main() {
  const { GITHUB_OUTPUT } = process.env;
  if (!GITHUB_OUTPUT) throw new Error("実行環境が不足しています。");

  const context = await previewContext();
  const pilots = nativePilotPrs(process.env.MILLE_PR_PREVIEW_MODE, process.env.MILLE_NATIVE_PREVIEW_PILOTS);
  const { targets, deploy } = selectPreviewWork(await context.targets(), pilots);
  await appendFile(GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\ndeploy_target=${deploy ? JSON.stringify(deploy) : ""}\n`);
  if (!targets.length) console.log("照合できた対象はありません。");
  for (const target of targets) console.log(`PR #${target.number} ${target.sha} ${target.operation}`);
}

main().catch(() => {
  console.error("PR イベントを確認できませんでした。");
  process.exitCode = 1;
});
