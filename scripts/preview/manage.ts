import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { previewMigrationSources } from "./database";
import { previewContext } from "./github";
import { assertPreviewGitDeploymentPolicy } from "./git-policy";
import { NeonPreview, NeonPreviewError } from "./neon";
import { loadPreviewSource } from "./source";
import { previewTargetIsCurrent, previewTargetSchema, samePreviewTarget } from "./target";
import { VercelPreview } from "./vercel";

const configuration = z.object({
  MILLE_PR_PREVIEW_ENABLED: z.literal("true"),
  VERCEL_TOKEN: z.string().min(1),
  NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/),
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: z.string().regex(/^br-[a-z0-9-]+$/),
  MILLE_PR_PREVIEW_MAX_BRANCHES: z.string().regex(/^[1-9][0-9]?$/).transform(Number),
});

let stage = "実行元と PR の照合";
async function main() {
  const target = previewTargetSchema.parse(JSON.parse(process.env.MILLE_PR_PREVIEW_TARGET ?? ""));
  const context = await previewContext();
  const targets = await context.targets();
  if (!targets.some((value) => samePreviewTarget(value, target))) {
    console.log("PR イベントが変更されたため処理を終了しました。");
    return;
  }

  const verifyCurrent = async () => {
    if (!await previewTargetIsCurrent(target, context.read)) {
      throw new Error("PR の SHA または状態が変わりました。");
    }
  };
  await verifyCurrent();
  if (target.operation === "deploy") {
    stage = "通常の Git デプロイを制限する設定の照合";
    await assertPreviewGitDeploymentPolicy(context.controlSha, target.sha, context.read);
  }
  stage = "管理ジョブの設定の検証";
  const config = configuration.parse(process.env);
  const neon = new NeonPreview({
    apiKey: config.NEON_API_KEY,
    projectId: config.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
    parentBranchId: config.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID,
    database: "mille_pr",
    role: "mille_pr_owner",
    maxPrBranches: config.MILLE_PR_PREVIEW_MAX_BRANCHES,
  });
  const vercel = new VercelPreview({
    token: config.VERCEL_TOKEN,
    teamId: config.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
    projectId: config.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID,
  });

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (target.operation === "cleanup") {
    stage = "PR 専用 Vercel デプロイの削除";
    await vercel.remove(target.number, verifyCurrent);
    stage = "PR 専用 Neon ブランチの削除";
    await neon.remove(target.number, verifyCurrent);
    if (summary) await appendFile(summary, `PR #${target.number} (${target.sha}) の専用リソースを整理しました。\n`);
    return;
  }

  stage = "Vercel と Neon のプロジェクトと PR の分離設定の照合";
  await Promise.all([vercel.preflight(), neon.preflight()]);
  stage = "照合済み PR ソースの取得";
  const files = await loadPreviewSource(target, context.token);
  const migrations = previewMigrationSources(files);
  stage = "PR 専用 Neon DB の準備";
  const database = await neon.ensure(target.number, verifyCurrent, migrations);
  stage = "PR 専用 Vercel Preview の準備";
  const deployment = await vercel.deploy(target, database, files, verifyCurrent);
  const { url } = deployment;
  stage = "現在の PR HEAD と Preview URL の確認";
  await verifyCurrent();
  if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(url)) throw new Error("Preview URL が無効です。");
  if (summary) await appendFile(summary, `PR #${target.number} (${target.sha}) Preview [${url}](${url})\n`);
  console.log(`PR #${target.number} (${target.sha}) Preview ${url}`);
  if (process.env.GITHUB_OUTPUT) {
    const ready = { number: target.number, sha: target.sha, deployment };
    await appendFile(process.env.GITHUB_OUTPUT, `ready=${JSON.stringify(ready)}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(`Mille PR Preview は「${stage}」で停止しました。資格情報やプロバイダーの応答本文は出力しません。`);
  if (error instanceof NeonPreviewError) console.error(`Neon 診断 ${error.diagnostic}`);
  process.exitCode = 1;
});
