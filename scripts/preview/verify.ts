import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { verifyBrowser, type BrowserProof } from "../cloud/verify";
import { previewContext } from "./github";
import { readPreviewStatus, type PreviewStatus } from "./status";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const proofInput = z.object({
  MILLE_PR_PREVIEW_PROOF_OPERATION: z.enum(["status", "verify"]),
  MILLE_PR_PREVIEW_PROOF_PR: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.int().max(2147483647)),
  MILLE_PR_PREVIEW_PROOF_SHA: sha,
  MILLE_PR_PREVIEW_PROOF_CONTROL_SHA: sha,
  MILLE_PR_PREVIEW_PROOF_DEPLOYMENT_ID: z.string().optional(),
  GITHUB_RUN_ID: z.string().regex(/^[1-9][0-9]*$/),
  GITHUB_RUN_ATTEMPT: z.string().regex(/^[1-9][0-9]*$/),
});

const oidcConfig = z.object({
  VERCEL_TOKEN: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
});
const oidcResponse = z.object({
  env: z.object({ VERCEL_OIDC_TOKEN: z.string().max(32768).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) }),
});
const oidcClaims = z.object({
  project_id: z.string(), owner_id: z.string(), environment: z.literal("development"), exp: z.int(),
});

export async function readDevelopmentOidc(environment: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch) {
  try {
    const config = oidcConfig.parse(environment);
    const url = new URL(`/v3/env/pull/${config.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID}/development`, "https://api.vercel.com");
    url.searchParams.set("teamId", config.MILLE_PR_PREVIEW_VERCEL_TEAM_ID);
    const response = await request(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.VERCEL_TOKEN}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error();
    const { env } = oidcResponse.parse(await response.json());
    const token = env.VERCEL_OIDC_TOKEN;
    const claims = oidcClaims.parse(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
    if (claims.project_id !== config.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID
      || claims.owner_id !== config.MILLE_PR_PREVIEW_VERCEL_TEAM_ID || claims.exp * 1000 < Date.now() + 60_000) throw new Error();
    return token;
  } catch {
    throw new Error("Vercel の正式 Preview 用 OIDC を確認できません。");
  }
}

const expectedCases = ["desktop-user-a", "desktop-user-b", "mobile-user-a", "mobile-user-b"];

export function readVerifiedBrowserEvidence(controlSha: string, target: { origin: string; sha: string }, result: BrowserProof) {
  const cases = result.cases.map(({ name, status }) => ({ name, status }));
  if (!result.success || result.source.before?.sha !== controlSha || result.source.after?.sha !== controlSha
    || !result.source.unchanged || result.target.kind !== "preview" || result.target.origin !== target.origin
    || result.target.expectedSha !== target.sha || result.target.runtimeSha !== target.sha
    || !Object.values(result.resources).every(count => count === 0) || cases.length !== expectedCases.length
    || !expectedCases.every(name => cases.some(entry => entry.name === name && entry.status === "passed"))
    || result.cases.some(entry => !entry.checks.includes("runtime-sha") || !entry.checks.includes("runtime-after"))) {
    throw new Error("正式 Preview のブラウザ証跡を照合できません。");
  }
  return { cases, runtimeSha: target.sha, finishedAt: result.finishedAt, durationMs: result.durationMs };
}

export async function verifyCurrentPreview(
  expectedDeployment: string,
  controlSha: string,
  status: () => Promise<PreviewStatus>,
  browse: (target: PreviewStatus) => Promise<BrowserProof>,
) {
  const before = await status();
  if (before.deploymentId !== expectedDeployment) throw new Error("正式 Preview のデプロイが一致しません。");
  const result = await browse(before);
  const after = await status();
  if (!isDeepStrictEqual(before, after)) throw new Error("ブラウザ検証中に正式 Preview が変わりました。");
  return { target: after, browser: readVerifiedBrowserEvidence(controlSha, before, result) };
}

const mainRef = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ sha }) });

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("正式 Preview の手動実行が必要です。");
  const input = proofInput.parse(process.env);
  const { read, controlSha } = await previewContext();
  if (controlSha !== input.MILLE_PR_PREVIEW_PROOF_CONTROL_SHA) throw new Error("指定した main の SHA が一致しません。");
  const operation = input.MILLE_PR_PREVIEW_PROOF_OPERATION;
  const expected = input.MILLE_PR_PREVIEW_PROOF_DEPLOYMENT_ID;
  const verifiedMain = async () => {
    const current = mainRef.parse(await read("git/ref/heads/main"));
    if (current.object.sha !== controlSha) throw new Error("確認中に main が変わりました。");
  };
  await verifiedMain();
  const status = () => readPreviewStatus({ pr: input.MILLE_PR_PREVIEW_PROOF_PR, sha: input.MILLE_PR_PREVIEW_PROOF_SHA, read });
  let snapshot: { target: PreviewStatus; browser?: Awaited<ReturnType<typeof verifyCurrentPreview>>["browser"] };
  if (operation === "verify") {
    snapshot = await verifyCurrentPreview(deploymentId.parse(expected), controlSha, status, async target => {
      const token = await readDevelopmentOidc(process.env);
      const result = await verifyBrowser([], { origin: target.origin, sha: target.sha, token });
      if (!result.success && result.failure?.stage) console.error(`正式 Preview のブラウザ検証は ${result.failure.stage} で停止しました。`);
      return result;
    });
  } else {
    if (expected) throw new Error("status にデプロイ ID は指定できません。");
    snapshot = { target: await status() };
  }
  await verifiedMain();
  const receipt = {
    protocol: "mille-preview-proof/v1", operation, controlSha,
    runId: input.GITHUB_RUN_ID, runAttempt: input.GITHUB_RUN_ATTEMPT, ...snapshot,
  };
  const output = JSON.stringify(receipt);
  const directory = resolve(".mille/cloud");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "preview-proof.json"), `${output}\n`, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `正式 Preview ${operation} / PR #${snapshot.target.pr}\n\n\`\`\`json\n${output}\n\`\`\`\n`);
  }
  console.log(`正式 Preview ${operation} を確認しました。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("正式 Preview の状態またはブラウザ検証の照合に失敗しました。");
    process.exitCode = 1;
  });
}
