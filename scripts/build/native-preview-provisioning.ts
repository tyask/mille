import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

const phase = "provision";
const markerName = ".mille-native-preview-provisioning";
const markerProtocol = "mille-native-preview-provisioning/v1";
const outputConfig = JSON.stringify({
  version: 3,
  routes: [
    {
      src: "/(.*)",
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
        "X-Mille-Preview-Phase": phase,
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      },
      continue: true,
    },
    { src: "/", dest: "/index.html", methods: ["GET", "HEAD"] },
    { src: "/(.*)", status: 404 },
  ],
}) + "\n";
const indexHtml = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mille Preview準備中</title>
<h1>mille Previewを準備しています</h1>
<p>検証用アプリのURLは、専用DBの照合とビルドが完了した後にPRへ表示されます。</p>
</html>
`;

function isTaskBranch(branch: string): boolean {
  return /^codex\/[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(branch) && !branch.includes("..") && !branch.endsWith(".")
    && branch.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isNativePreviewProvisioning(environment: Environment): boolean {
  const requested = environment.MILLE_NATIVE_PREVIEW_PHASE;
  if (requested === undefined) return false;

  const branch = environment.MILLE_NATIVE_PREVIEW_SOURCE_BRANCH ?? "";
  const sha = environment.MILLE_NATIVE_PREVIEW_SOURCE_SHA ?? "";
  const pr = environment.MILLE_NATIVE_PREVIEW_PR ?? "";
  const generation = environment.MILLE_NATIVE_PREVIEW_GENERATION ?? "";
  if (requested !== phase || environment.VERCEL !== "1" || !environment.VERCEL_BUILD_IMAGE?.trim()
    || environment.VERCEL_ENV !== "preview" || environment.AUTH_MODE !== "test"
    || (environment.VERCEL_TARGET_ENV !== undefined && environment.VERCEL_TARGET_ENV !== "preview")
    || !/^dpl_[A-Za-z0-9]+$/.test(environment.VERCEL_DEPLOYMENT_ID ?? "")
    || environment.VERCEL_GIT_REPO_OWNER !== "tyask" || environment.VERCEL_GIT_REPO_SLUG !== "mille"
    || !isTaskBranch(branch) || branch !== environment.VERCEL_GIT_COMMIT_REF
    || !/^[a-f0-9]{40}$/.test(sha) || sha !== environment.VERCEL_GIT_COMMIT_SHA
    || !/^[1-9][0-9]*$/.test(pr) || !Number.isSafeInteger(Number(pr))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(generation)) {
    throw new Error("Native Previewの準備用ビルドの対象を確認できません。");
  }
  return true;
}

function realDirectory(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error("Native Previewの出力先は実ディレクトリである必要があります。");
  return true;
}

function regularFile(path: string): Buffer | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error("Native Previewの準備用ファイルの種類を確認してください。");
  return readFileSync(path);
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

function paths(root: string) {
  const project = resolve(root);
  if (!realDirectory(project)) throw new Error("Native Previewの作業ディレクトリが見つかりません。");
  const next = join(project, ".next");
  const vercel = join(project, ".vercel");
  return { next, vercel, marker: join(next, markerName), nextOutput: join(next, "output"), vercelOutput: join(vercel, "output") };
}

function matchesProvisioningArtifact(output: string, configHash: string, indexHash: string): boolean {
  const entries = readdirSync(output);
  if (entries.length !== 2 || !entries.includes("config.json") || !entries.includes("static")) return false;
  const assets = join(output, "static");
  const files = realDirectory(assets) ? readdirSync(assets) : [];
  if (files.length !== 1 || files[0] !== "index.html") return false;
  const configuration = regularFile(join(output, "config.json"));
  const index = regularFile(join(assets, "index.html"));
  return configuration !== undefined && index !== undefined && sha256(configuration) === configHash && sha256(index) === indexHash;
}

/** Ordinary builds remove an artifact only when its marker and static contents still match. */
export function clearNativePreviewProvisioningOutput(root: string): void {
  const { next, vercel, marker, nextOutput, vercelOutput } = paths(root);
  if (!realDirectory(next)) return;
  const markerValue = regularFile(marker)?.toString("utf8");
  if (markerValue === undefined) return;
  const [protocol, configHash, indexHash, end, ...extra] = markerValue.split("\n");
  const checksum = /^[a-f0-9]{64}$/;
  if (protocol !== markerProtocol || !checksum.test(configHash) || !checksum.test(indexHash) || end !== "" || extra.length) {
    throw new Error("Native Previewの準備用マーカーを確認できません。");
  }

  realDirectory(vercel);
  const artifacts = [nextOutput, vercelOutput].filter(realDirectory);
  if (artifacts.some(artifact => !matchesProvisioningArtifact(artifact, configHash, indexHash))) {
    throw new Error("Native Previewの準備用出力を照合できません。");
  }
  for (const artifact of artifacts) rmSync(artifact, { recursive: true });
  rmSync(marker);
}

export function writeNativePreviewProvisioningOutput(root: string): void {
  const { next, vercel, marker, nextOutput, vercelOutput } = paths(root);
  // Inspect both parents before deleting either cache. `.vercel/project.json` is outside the output.
  realDirectory(next);
  realDirectory(vercel);
  realDirectory(nextOutput);
  realDirectory(vercelOutput);
  rmSync(next, { recursive: true, force: true });
  rmSync(vercelOutput, { recursive: true, force: true });

  mkdirSync(next);
  writeFileSync(marker, `${markerProtocol}\n${sha256(outputConfig)}\n${sha256(indexHtml)}\n`, { flag: "wx" });
  try {
    mkdirSync(nextOutput);
    const assets = join(nextOutput, "static");
    mkdirSync(assets);
    writeFileSync(join(nextOutput, "config.json"), outputConfig, { flag: "wx" });
    writeFileSync(join(assets, "index.html"), indexHtml, { flag: "wx" });
  } catch (error) {
    rmSync(nextOutput, { recursive: true, force: true });
    throw error;
  }
}
