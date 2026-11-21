import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { previewContext } from "./github";
import { assertPreviewGitDeploymentPolicy } from "./git-policy";
import { loadPreviewSource } from "./source";
import { resolveNativePreviewSource, type PreviewTarget } from "./target";
import { assertPreviewVercelSource, type PreviewSourceFile } from "./vercel";

type InspectionSource = {
  controlSha: string;
  read(path: string): Promise<unknown>;
  loadFiles(target: PreviewTarget): Promise<readonly PreviewSourceFile[]>;
};

const npmBuild = z.object({
  scripts: z.object({
    "build:vercel": z.literal("node --import tsx scripts/build/vercel-build.ts"),
    "prebuild:vercel": z.never().optional(),
    "postbuild:vercel": z.never().optional(),
  }),
});

const vercelBuild = z.object({
  buildCommand: z.literal("npm run build:vercel"),
  builds: z.never().optional(),
  installCommand: z.never().optional(),
  ignoreCommand: z.never().optional(),
  outputDirectory: z.never().optional(),
  framework: z.never().optional(),
});

function assertNativeBuildCommand(files: readonly PreviewSourceFile[]) {
  if (!vercelBuild.safeParse(assertPreviewVercelSource(files)).success) {
    throw new Error("Native Preview 用の Vercel ビルド設定が一致しません。");
  }
  const npmPackage = files.find(({ file }) => file === "package.json");
  let contents: unknown;
  try {
    contents = JSON.parse(npmPackage?.data.toString("utf8") ?? "");
  } catch {
    throw new Error("Native Preview 用の package.json を確認できません。");
  }
  if (!npmBuild.safeParse(contents).success) throw new Error("Native Preview 用の npm ビルドコマンドが一致しません。");
}

export async function inspectNativePreviewSource(target: PreviewTarget, input: InspectionSource) {
  const source = await resolveNativePreviewSource(target, input.read);
  await assertPreviewGitDeploymentPolicy(input.controlSha, target.sha, input.read);
  assertNativeBuildCommand(await input.loadFiles(target));
  const current = await resolveNativePreviewSource(target, input.read);
  if (current.ref !== source.ref || current.repoId !== source.repoId || current.createdAt !== source.createdAt) {
    throw new Error("照合中に Native Preview の PR ソースが変わりました。");
  }
  return {
    number: source.number,
    createdAt: source.createdAt,
    gitSource: { type: "github" as const, repoId: source.repoId, ref: source.ref, sha: source.sha },
  };
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("手動の照合が必要です。");
  const inputs = z.object({
    MILLE_NATIVE_PREVIEW_INSPECT_PR: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.int().max(2147483647)),
    MILLE_NATIVE_PREVIEW_INSPECT_SHA: z.string().regex(/^[a-f0-9]{40}$/),
  }).parse(process.env);
  const context = await previewContext();
  const result = await inspectNativePreviewSource({
    operation: "deploy",
    number: inputs.MILLE_NATIVE_PREVIEW_INSPECT_PR,
    sha: inputs.MILLE_NATIVE_PREVIEW_INSPECT_SHA,
  }, {
    read: context.read,
    controlSha: context.controlSha,
    loadFiles: target => loadPreviewSource(target, context.token),
  });
  const { number, gitSource } = result;
  const line = `PR #${number} (${gitSource.sha}) の Native Preview 用 Git ソース ${gitSource.ref} を照合しました。`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  console.log(line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Native Preview 用 Git ソースを照合できません。実行元、PR と SHA、Vercel と npm のビルド設定を確認してください。");
    process.exitCode = 1;
  });
}
