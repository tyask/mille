import { appendFile } from "node:fs/promises";
import { previewContext } from "./github";

async function main() {
  const { GITHUB_OUTPUT } = process.env;
  if (!GITHUB_OUTPUT) throw new Error("実行環境が不足しています。");

  const context = await previewContext();
  const targets = await context.targets();
  const deploy = targets.find((target) => target.operation === "deploy");
  // Matrix results can only be used for a notification when a single job owns the output.
  if (deploy && targets.length !== 1) throw new Error("deploy の対象を1件に絞れませんでした。");
  await appendFile(GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\ndeploy_target=${deploy ? JSON.stringify(deploy) : ""}\n`);
  if (!targets.length) console.log("照合できた対象はありません。");
  for (const target of targets) console.log(`PR #${target.number} ${target.sha} ${target.operation}`);
}

main().catch(() => {
  console.error("PR イベントを確認できませんでした。");
  process.exitCode = 1;
});
