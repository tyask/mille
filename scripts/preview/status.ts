import { createHash } from "node:crypto";
import { z } from "zod";
import { nativePilotPrs } from "./native-pilot-selection";
import { NativePilotVercel } from "./native-pilot-vercel";
import { NeonPreview } from "./neon";
import { resolveNativePreviewSource } from "./target";
import { VercelPreview } from "./vercel";

const configuration = z.object({
  VERCEL_TOKEN: z.string().min(1),
  NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/),
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: z.string().regex(/^br-[a-z0-9-]+$/),
  MILLE_PR_PREVIEW_MAX_BRANCHES: z.string().regex(/^[1-9][0-9]?$/).transform(Number),
});

export type PreviewStatus = {
  pr: number;
  ref: string;
  sha: string;
  deploymentId: string;
  origin: string;
  mode: "legacy" | "native-pilot";
  database: { branchId: string; endpointId: string; generation: string };
};

type StatusInput = {
  pr: number;
  sha: string;
  read: (path: string) => Promise<unknown>;
  environment?: Readonly<Record<string, string | undefined>>;
};

function readOnlyProviderRequest(request: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (input instanceof Request || init?.method !== "GET" || init.body != null || init.redirect !== "error") {
      throw new Error("Preview の状態確認には読み取り専用のリクエストが必要です。");
    }
    const url = new URL(input);
    if ((url.origin !== "https://api.vercel.com" && url.origin !== "https://console.neon.tech")
      || url.username || url.password || url.pathname.endsWith("/connection_uri")) {
      throw new Error("Preview の状態確認に使えない取得先です。");
    }
    return request(url, init);
  };
}

export async function readPreviewStatus(
  { pr, sha, read, environment = process.env }: StatusInput,
  { request = fetch }: { request?: typeof fetch } = {},
): Promise<PreviewStatus> {
  const target = { number: pr, sha, operation: "deploy" } as const;
  const current = await resolveNativePreviewSource(target, read);
  const pilots = nativePilotPrs(environment.MILLE_PR_PREVIEW_MODE, environment.MILLE_NATIVE_PREVIEW_PILOTS);
  if (pilots && !pilots.includes(pr)) throw new Error("この PR は Native Preview の試験対象ではありません。");
  const parsed = configuration.safeParse(environment);
  if (!parsed.success) throw new Error("Preview の状態確認に必要な設定が揃っていません。");
  const config = parsed.data;
  const readOnlyRequest = readOnlyProviderRequest(request);
  const neon = new NeonPreview({
    apiKey: config.NEON_API_KEY,
    projectId: config.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
    parentBranchId: config.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID,
    database: "mille_pr",
    role: "mille_pr_owner",
    maxPrBranches: config.MILLE_PR_PREVIEW_MAX_BRANCHES,
  }, readOnlyRequest);
  const vercel = {
    token: config.VERCEL_TOKEN,
    projectId: config.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID,
    teamId: config.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
  };

  let status: PreviewStatus;
  if (pilots) {
    const deployment = await new NativePilotVercel(vercel, readOnlyRequest).readReadyApplication({ pr, ref: current.ref, sha });
    const branch = await neon.findNativeBranch(current.ref, undefined, deployment.readyAt);
    const { database } = deployment;
    if (!branch || branch.id !== database.branchId || branch.endpointId !== database.endpointId
      || createHash("sha256").update(branch.host).digest("hex") !== database.hostDigest) {
      throw new Error("Native Preview のアプリと専用 DB の所有が一致しません。");
    }
    status = { pr, ref: current.ref, sha, deploymentId: deployment.id, origin: deployment.url,
      mode: "native-pilot", database: { branchId: branch.id, endpointId: branch.endpointId, generation: deployment.generation } };
  } else {
    const branch = await neon.readPreviewBranch(pr);
    const deployment = await new VercelPreview(vercel, readOnlyRequest).readReadyPreview(target, branch.host);
    status = { pr, ref: current.ref, sha, deploymentId: deployment.id, origin: deployment.url,
      mode: "legacy", database: { branchId: branch.id, endpointId: branch.endpointId, generation: branch.id } };
  }
  const verified = await resolveNativePreviewSource(target, read);
  if (verified.ref !== current.ref || verified.createdAt !== current.createdAt) {
    throw new Error("状態確認中に PR の所属が変わりました。");
  }
  return status;
}
