import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertPreviewGitDeploymentPolicy } from "./git-policy";
import { NativePilotStageError, nativePilotStage } from "./native-pilot-diagnostics";
import { assertNativePilotSource } from "./native-pilot-source";
import { NativePilotVercel, type NativePilotDatabase, type NativePilotDeployment } from "./native-pilot-vercel";
import type { NativeNeonBranch, NativePeerBranch, NeonPreview } from "./neon";
import { resolveNativePreviewIdentity, samePreviewTarget, type PreviewTarget } from "./target";

const settings = z.object({
  MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: z.string().regex(/^br-[a-z0-9-]+$/),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: z.string().regex(/^ep-[a-z0-9-]+$/),
});

type PilotIdentity = Awaited<ReturnType<typeof resolveNativePreviewIdentity>>;
type PilotVercel = Pick<NativePilotVercel, "preflight" | "list" | "provision" | "confirmStatic"
  | "deployApplication" | "confirmApplication" | "waitForTerminal" | "remove">;
type PilotNeon = Pick<NeonPreview, "nativePreflight" | "findNativeBranch" | "prepareNativeBranch"
  | "removeNativeBranch" | "confirmNativeBranchAbsent">;
type Application = Extract<NativePilotDeployment, { phase: "application" }>;
type Provision = Extract<NativePilotDeployment, { phase: "provision" }>;
type VerifyCurrent = () => Promise<void>;

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
  verifyApplicationCreation(pr: number, sha: string, createdAt: string): Promise<void>;
};

const targetOf = (identity: PilotIdentity) => ({ pr: identity.number, ref: identity.ref, sha: identity.sha });
const isPilotRef = (ref: string) => /^codex\/native-preview-pilot-[ab]$/.test(ref);
const terminalStates = new Set(["READY", "ERROR", "CANCELED", "BLOCKED"]);

function verifyNativePilotEndpoint(endpointId: string, buildEndpointId: string) {
  if (endpointId !== buildEndpointId) {
    throw new NativePilotStageError("ownership", new Error("Native Preview の試験デプロイと Neon の接続先が一致しません。"));
  }
}

function databaseIdentity(branch: NativeNeonBranch): NativePilotDatabase {
  return { branchId: branch.id, endpointId: branch.endpointId,
    hostDigest: createHash("sha256").update(branch.host).digest("hex") };
}

function verifyApplicationDatabase(application: Application, database: NativePilotDatabase) {
  const recorded = application.database;
  if (recorded.branchId !== database.branchId || recorded.hostDigest !== database.hostDigest) {
    throw new NativePilotStageError("ownership", new Error("Native Preview のアプリと専用 DB の所有が一致しません。"));
  }
  verifyNativePilotEndpoint(recorded.endpointId, database.endpointId);
}

function separateDeployments(deployments: NativePilotDeployment[]) {
  return {
    provision: deployments.find((item): item is Provision => item.phase === "provision"),
    applications: deployments.filter((item): item is Application => item.phase === "application"),
  };
}

function branchEvidence({ provision, applications }: ReturnType<typeof separateDeployments>) {
  return provision ?? applications.find(item => item.readyState === "READY");
}

async function confirmBranchEvidence(vercel: PilotVercel, record: NativePilotDeployment, verifyCurrent: VerifyCurrent) {
  const ready = record.phase === "provision"
    ? await nativePilotStage("vercel-static", () => vercel.confirmStatic(record, verifyCurrent))
    : await nativePilotStage("vercel-application", () => vercel.confirmApplication(record, verifyCurrent));
  if (ready.readyAt === undefined) throw new Error("Native Preview のデプロイの準備完了時刻がありません。");
  return { ...ready, notBefore: record.phase === "provision" ? ready.requestedAt : undefined, readyAt: ready.readyAt };
}

async function cleanupPilot(
  input: PilotOperation, identity: PilotIdentity, deployments: NativePilotDeployment[], verifyCurrent: VerifyCurrent,
) {
  const { neon, vercel } = input;
  const terminal = await Promise.all(deployments.map(item =>
    terminalStates.has(item.readyState) ? item : vercel.waitForTerminal(item, verifyCurrent)));
  const groups = separateDeployments(terminal);
  const { provision, applications } = groups;
  const record = branchEvidence(groups);
  const proof = record && await confirmBranchEvidence(vercel, record, verifyCurrent);
  const branch = await nativePilotStage("neon-branch", () =>
    neon.findNativeBranch(identity.ref, proof?.notBefore, proof?.readyAt));
  if (!deployments.length) {
    if (branch) throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
    return;
  }

  // Keep a READY application as recovery evidence until all other resources are absent.
  const anchor = applications.find(item => item.readyState === "READY") ?? applications.at(-1);
  if (branch && !proof) {
    throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
  }
  const database = branch ? databaseIdentity(branch) : anchor?.database;
  const evidence = anchor ?? provision;
  if (!database || !evidence) {
    throw new Error("先行試行の Neon ブランチと接続先の不在を直接確認できません。Deployment の記録を保持します。");
  }
  if (proof) verifyNativePilotEndpoint(database.endpointId, proof.endpointId);
  for (const app of applications) verifyApplicationDatabase(app, database);

  console.log(`Native Preview 削除照合 ${evidence.id} ${database.branchId} ${database.endpointId}`);
  for (const app of applications) {
    if (app.id !== anchor?.id) await vercel.remove(app, verifyCurrent);
  }
  if (branch && proof) {
    await neon.removeNativeBranch(identity.ref, branch, proof.notBefore, verifyCurrent, proof.readyAt);
  } else {
    await neon.confirmNativeBranchAbsent(identity.ref, database);
  }
  if (provision) await vercel.remove(provision, verifyCurrent);
  if (anchor) await vercel.remove(anchor, verifyCurrent);
  if ((await vercel.list(targetOf(identity))).length) throw new Error("Native Preview の試験デプロイが残っています。");
}

export async function executeNativePilot(input: PilotOperation): Promise<{ id: string; url: string } | "removed"> {
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
  const deployments = await nativePilotStage("vercel-inventory", () => vercel.list(requested));

  if (target.operation === "cleanup") {
    await nativePilotStage("cleanup", () => cleanupPilot(input, identity, deployments, verifyCurrent));
    return "removed";
  }

  const groups = separateDeployments(deployments);
  const existing = branchEvidence(groups);
  const { applications } = groups;
  const currentApplication = applications.find(item => item.sha === requested.sha);
  if (existing && !currentApplication) {
    await nativePilotStage("github-history", () => input.verifyApplicationCreation(target.number, target.sha, identity.createdAt));
  }
  // An existing branch without our deployment evidence could belong to an earlier PR using this ref.
  if (!existing) {
    if (deployments.length) throw new Error("Native Preview の試験用ブランチの所有記録を確認できません。");
    await nativePilotStage("neon-branch", async () => {
      if (await neon.findNativeBranch(identity.ref)) {
        throw new Error("Native Preview の試験用ブランチの所有を確認できません。");
      }
    });
    await nativePilotStage("github-history", () => input.verifyFirstCreation(target.number, identity.createdAt));
  }
  const record = existing ?? await nativePilotStage("vercel-create-request", () =>
    vercel.provision(requested, randomUUID(), verifyCurrent));
  const deployment = await confirmBranchEvidence(vercel, record, verifyCurrent);
  const branch = await nativePilotStage("neon-branch", async () => {
    const child = await neon.findNativeBranch(identity.ref, deployment.notBefore, deployment.readyAt);
    if (!child) throw new Error("Native Preview の試験用ブランチを確認できません。");
    return child;
  });
  verifyNativePilotEndpoint(branch.endpointId, deployment.endpointId);
  const database = databaseIdentity(branch);
  for (const app of applications) verifyApplicationDatabase(app, database);
  if (currentApplication) {
    return nativePilotStage("vercel-application", () => vercel.confirmApplication(currentApplication, verifyCurrent));
  }

  const peerBranches: NativePeerBranch[] = [];
  for (const peer of peers) {
    const records = await nativePilotStage("vercel-inventory", () => vercel.list(targetOf(peer)));
    const evidence = branchEvidence(separateDeployments(records));
    const peerBranch = await nativePilotStage("neon-branch", () =>
      neon.findNativeBranch(peer.ref, evidence?.phase === "provision" ? evidence.requestedAt : undefined, evidence?.readyAt));
    if (peerBranch) {
      if (evidence?.readyAt === undefined) {
        throw new NativePilotStageError("ownership", new Error("比較する Native Preview ブランチの所有を確認できません。"));
      }
      const verified = await confirmBranchEvidence(vercel, evidence, verifyCurrent);
      verifyNativePilotEndpoint(peerBranch.endpointId, verified.endpointId);
      if (evidence.phase === "application") verifyApplicationDatabase(evidence, databaseIdentity(peerBranch));
      peerBranches.push({ ref: peer.ref, branch: peerBranch });
    } else if (records.length) {
      throw new NativePilotStageError("ownership", new Error("比較する Native Preview ブランチを確認できません。"));
    }
  }
  await verifyCurrent();
  await nativePilotStage("neon-isolation", () => neon.prepareNativeBranch(
    identity.ref, branch, deployment.notBefore, target.number, deployment.generation,
    standingBranchId, peerBranches, verifyCurrent, deployment.readyAt,
  ));
  const application = await nativePilotStage("vercel-create-request", () =>
    vercel.deployApplication(requested, deployment.generation, database, verifyCurrent));
  return nativePilotStage("vercel-application", () => vercel.confirmApplication(application, verifyCurrent));
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
