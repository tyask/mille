import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertPreviewGitDeploymentPolicy } from "./git-policy";
import { assertNativePilotSource } from "./native-pilot-source";
import { NativePilotVercel } from "./native-pilot-vercel";
import { nativePreviewStoreAccess } from "./native-preview-store";
import type { NeonPreview } from "./neon";
import { resolveNativePreviewIdentity, samePreviewTarget, type PreviewTarget } from "./target";

const settings = z.object({
  VERCEL_NATIVE_PREVIEW_STORE_TOKEN: nativePreviewStoreAccess.shape.storeToken,
  MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID: nativePreviewStoreAccess.shape.storeId,
  MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID: z.string().regex(/^icfg_[A-Za-z0-9]+$/),
  MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID: z.string().regex(/^iap_[A-Za-z0-9]+$/),
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
    throw new Error("Native Preview の試験デプロイと Neon の接続先が一致しません。");
  }
}

export async function executeNativePilot(input: PilotOperation): Promise<"prepared" | "removed"> {
  const { target, controlSha, pilotPrs, read, vercel, neon, standingBranchId, standingEndpointId } = input;
  if (!pilotPrs.includes(target.number)) throw new Error("Native Preview の試験対象ではありません。");

  const identity = await resolveNativePreviewIdentity(target.number, read);
  if (!isPilotRef(identity.ref)) {
    throw new Error("Native Preview の試験用 Git ブランチではありません。");
  }
  const assertCurrent = (current: PilotIdentity) => {
    if (!samePreviewTarget(current.target, target) || current.ref !== identity.ref
      || current.createdAt !== identity.createdAt) throw new Error("Native Preview の試験 PR の状態が変わりました。");
  };
  const verifyCurrent = async () => assertCurrent(await resolveNativePreviewIdentity(target.number, read));
  assertCurrent(identity);
  const peers = await Promise.all(pilotPrs.filter(pr => pr !== target.number).map(pr => resolveNativePreviewIdentity(pr, read)));
  if (peers.some(peer => !isPilotRef(peer.ref) || peer.ref === identity.ref)) {
    throw new Error("Native Preview の試験 PR の Git ブランチが一致しません。");
  }

  if (target.operation === "deploy") {
    await assertNativePilotSource(controlSha, target.sha, read);
    await assertPreviewGitDeploymentPolicy(controlSha, target.sha, read);
  }
  await Promise.all([
    vercel.preflight(),
    neon.nativePreflight(standingBranchId, standingEndpointId, [identity.ref, ...peers.map(peer => peer.ref)]),
  ]);
  await verifyCurrent();
  const requested = targetOf(identity);
  const existing = await vercel.find(requested, target.operation === "deploy");

  if (target.operation === "cleanup") {
    if (existing && !["READY", "ERROR", "CANCELED", "BLOCKED"].includes(existing.readyState)) {
      throw new Error("Native Preview の試験デプロイの終了を確認できません。");
    }
    const branch = await neon.findNativeBranch(identity.ref, existing?.requestedAt, existing?.readyAt);
    if (!existing) {
      if (branch) throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
      return "removed";
    }
    if (branch) {
      if (existing.readyAt === undefined) throw new Error("Native Preview の試験用ブランチの作成期間を確認できません。");
      verifyNativePilotEndpoint(branch.host, existing.endpointDigest);
      // Keep these public IDs in the trusted job log for recovery if a run stops during deletion.
      console.log(`Native Preview 削除照合 ${existing.id} ${branch.id} ${branch.endpointId}`);
      await neon.removeNativeBranch(identity.ref, branch, existing.requestedAt, verifyCurrent, existing.readyAt);
    } else {
      throw new Error("先行試行の Neon ブランチと接続先の不在を直接確認できません。Deployment の記録を保持します。");
    }
    await vercel.remove(existing, verifyCurrent);
    return "removed";
  }

  // An existing branch without our deployment evidence could belong to an earlier PR using this ref.
  if (!existing && await neon.findNativeBranch(identity.ref)) {
    throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
  }
  if (!existing) await input.verifyFirstCreation(target.number, identity.createdAt);
  const deployment = await vercel.confirmStatic(
    existing ?? await vercel.provision(requested, randomUUID(), verifyCurrent), verifyCurrent,
  );
  if (deployment.readyAt === undefined) throw new Error("Native Preview の試験用デプロイの準備完了時刻がありません。");
  const branch = await neon.findNativeBranch(identity.ref, deployment.requestedAt, deployment.readyAt);
  if (!branch) throw new Error("Native Preview の試験用ブランチを確認できません。");
  verifyNativePilotEndpoint(branch.host, deployment.endpointDigest);

  const peerRefs: string[] = [];
  for (const peer of peers) {
    const evidence = await vercel.find(targetOf(peer), false);
    const peerBranch = await neon.findNativeBranch(peer.ref, evidence?.requestedAt, evidence?.readyAt);
    if (peerBranch) {
      if (evidence?.readyAt === undefined) throw new Error("比較する Native Preview ブランチの所有を確認できません。");
      verifyNativePilotEndpoint(peerBranch.host, evidence.endpointDigest);
      peerRefs.push(peer.ref);
    }
  }
  await verifyCurrent();
  await neon.prepareNativeBranch(
    identity.ref, branch, deployment.requestedAt, target.number, standingBranchId, peerRefs, verifyCurrent, deployment.readyAt,
  );
  return "prepared";
}

export function nativePilotProviders(environment: NodeJS.ProcessEnv, input: {
  token: string; teamId: string; projectId: string; neonProjectId: string;
}) {
  const parsed = settings.safeParse(environment);
  if (!parsed.success || parsed.data.VERCEL_NATIVE_PREVIEW_STORE_TOKEN === environment.NEON_API_KEY?.trim()) {
    throw new Error("Native Preview の試験設定を確認できません。");
  }
  const env = parsed.data;
  return {
    vercel: new NativePilotVercel({
      ...input,
      storeToken: env.VERCEL_NATIVE_PREVIEW_STORE_TOKEN,
      storeId: env.MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID,
      integrationId: env.MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID,
      productId: env.MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID,
    }),
    standingBranchId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID,
    standingEndpointId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID,
  };
}
