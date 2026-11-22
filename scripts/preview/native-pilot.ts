import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertPreviewGitDeploymentPolicy } from "./git-policy";
import { NativePilotStageError, nativePilotStage } from "./native-pilot-diagnostics";
import { assertNativePilotSource } from "./native-pilot-source";
import { NativePilotVercel } from "./native-pilot-vercel";
import type { NeonPreview } from "./neon";
import { resolveNativePreviewIdentity, samePreviewTarget, type PreviewTarget } from "./target";

const settings = z.object({
  MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: z.string().regex(/^br-[a-z0-9-]+$/),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: z.string().regex(/^ep-[a-z0-9-]+$/),
});

type PilotIdentity = Awaited<ReturnType<typeof resolveNativePreviewIdentity>>;
type PilotVercel = Pick<NativePilotVercel, "preflight" | "find" | "provision" | "confirmStatic" | "remove">;
type PilotNeon = Pick<NeonPreview, "nativePreflight" | "findNativeBranch" | "prepareNativeBranch" | "removeNativeBranch">;

type PilotOperation = {
  target: PreviewTarget;
  pilotPrs: readonly number[];
  controlSha: string;
  read(path: string): Promise<unknown>;
  vercel: PilotVercel;
  neon: PilotNeon;
  standingBranchId: string;
  standingEndpointId: string;
  verifyFirstCreation(pr: number, createdAt: string): Promise<void>;
};

const targetOf = (identity: PilotIdentity) => ({ pr: identity.number, ref: identity.ref, sha: identity.sha });
const isPilotRef = (ref: string) => /^codex\/native-preview-pilot-[ab]$/.test(ref);

function verifyNativePilotEndpoint(host: string, digest: string | undefined) {
  if (!digest || createHash("sha256").update(host).digest("hex") !== digest) {
    throw new NativePilotStageError("ownership", new Error("Native Preview の試験デプロイと Neon の接続先が一致しません。"));
  }
}

export async function executeNativePilot(input: PilotOperation): Promise<"prepared" | "removed"> {
  const { target, controlSha, pilotPrs, read, vercel, neon, standingBranchId, standingEndpointId } = input;
  const identity = await nativePilotStage("github-target", async () => {
    if (!pilotPrs.includes(target.number)) throw new Error("Native Preview の試験対象ではありません。");
    const current = await resolveNativePreviewIdentity(target.number, read);
    if (!isPilotRef(current.ref)) throw new Error("Native Preview の試験用 Git ブランチではありません。");
    return current;
  });
  const assertCurrent = (current: PilotIdentity) => {
    if (!samePreviewTarget(current.target, target) || current.ref !== identity.ref
      || current.createdAt !== identity.createdAt) throw new Error("Native Preview の試験 PR の状態が変わりました。");
  };
  const verifyCurrent = () => nativePilotStage("github-target", async () =>
    assertCurrent(await resolveNativePreviewIdentity(target.number, read)));
  const peers = await nativePilotStage("github-target", async () => {
    assertCurrent(identity);
    const others = await Promise.all(pilotPrs.filter(pr => pr !== target.number).map(pr => resolveNativePreviewIdentity(pr, read)));
    if (others.some(peer => !isPilotRef(peer.ref) || peer.ref === identity.ref)) {
      throw new Error("Native Preview の試験 PR の Git ブランチが一致しません。");
    }
    return others;
  });

  if (target.operation === "deploy") {
    await nativePilotStage("github-source", () => assertNativePilotSource(controlSha, target.sha, read));
    await nativePilotStage("github-deployment-policy", () => assertPreviewGitDeploymentPolicy(controlSha, target.sha, read));
  }
  await Promise.all([
    nativePilotStage("vercel-preflight", () => vercel.preflight()),
    nativePilotStage("neon-preflight", () => neon.nativePreflight(standingBranchId, standingEndpointId, [identity.ref, ...peers.map(peer => peer.ref)])),
  ]);
  await verifyCurrent();
  const requested = targetOf(identity);
  const existing = await nativePilotStage("vercel-inventory", () => vercel.find(requested, target.operation === "deploy"));

  if (target.operation === "cleanup") {
    await nativePilotStage("cleanup", async () => {
      if (existing && !["READY", "ERROR", "CANCELED", "BLOCKED"].includes(existing.readyState)) {
        throw new Error("Native Preview の試験デプロイの終了を確認できません。");
      }
      const branch = await nativePilotStage("neon-branch", () =>
        neon.findNativeBranch(identity.ref, existing?.requestedAt, existing?.readyAt));
      if (!existing) {
        if (branch) throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
        return;
      }
      if (!branch) {
        throw new Error("先行試行の Neon ブランチと接続先の不在を直接確認できません。Deployment の記録を保持します。");
      }
      if (existing.readyAt === undefined) throw new Error("Native Preview の試験用ブランチの作成期間を確認できません。");
      verifyNativePilotEndpoint(branch.host, existing.endpointDigest);
      // Keep these public IDs in the trusted job log for recovery if a run stops during deletion.
      console.log(`Native Preview 削除照合 ${existing.id} ${branch.id} ${branch.endpointId}`);
      await neon.removeNativeBranch(identity.ref, branch, existing.requestedAt, verifyCurrent, existing.readyAt);
      await vercel.remove(existing, verifyCurrent);
    });
    return "removed";
  }

  // An existing branch without our deployment evidence could belong to an earlier PR using this ref.
  if (!existing) {
    await nativePilotStage("neon-branch", async () => {
      if (await neon.findNativeBranch(identity.ref)) {
        throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
      }
    });
    await nativePilotStage("github-history", () => input.verifyFirstCreation(target.number, identity.createdAt));
  }
  const provision = existing ?? await nativePilotStage("vercel-create-request", () =>
    vercel.provision(requested, randomUUID(), verifyCurrent));
  const deployment = await nativePilotStage("vercel-static", async () => {
    const ready = await vercel.confirmStatic(provision, verifyCurrent);
    if (ready.readyAt === undefined) throw new Error("Native Preview の試験用デプロイの準備完了時刻がありません。");
    return ready;
  });
  const branch = await nativePilotStage("neon-branch", async () => {
    const child = await neon.findNativeBranch(identity.ref, deployment.requestedAt, deployment.readyAt);
    if (!child) throw new Error("Native Preview の試験用ブランチを確認できません。");
    return child;
  });
  verifyNativePilotEndpoint(branch.host, deployment.endpointDigest);

  const peerRefs: string[] = [];
  for (const peer of peers) {
    const evidence = await nativePilotStage("vercel-inventory", () => vercel.find(targetOf(peer), false));
    const peerBranch = await nativePilotStage("neon-branch", () =>
      neon.findNativeBranch(peer.ref, evidence?.requestedAt, evidence?.readyAt));
    if (peerBranch) {
      if (evidence?.readyAt === undefined) {
        throw new NativePilotStageError("ownership", new Error("比較する Native Preview ブランチの所有を確認できません。"));
      }
      verifyNativePilotEndpoint(peerBranch.host, evidence.endpointDigest);
      peerRefs.push(peer.ref);
    }
  }
  await verifyCurrent();
  await nativePilotStage("neon-isolation", () => neon.prepareNativeBranch(
    identity.ref, branch, deployment.requestedAt, target.number, standingBranchId, peerRefs, verifyCurrent, deployment.readyAt,
  ));
  return "prepared";
}

export function nativePilotProviders(environment: NodeJS.ProcessEnv, input: {
  token: string; teamId: string; projectId: string;
}) {
  const parsed = settings.safeParse(environment);
  if (!parsed.success) throw new Error("Native Preview の試験設定が不足しています。");
  const env = parsed.data;
  return {
    vercel: new NativePilotVercel(input),
    standingBranchId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID,
    standingEndpointId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID,
  };
}
