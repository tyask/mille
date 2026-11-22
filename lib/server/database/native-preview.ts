import { createHash } from "node:crypto";

type Environment = Readonly<Record<string, string | undefined>>;

const pilotRef = /^codex\/native-preview-pilot-[ab]$/;
const generationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const neonBranchId = /^br-[a-z0-9][a-z0-9-]{0,56}$/;
const neonEndpointId = /^ep-[a-z0-9][a-z0-9-]{0,56}$/;
const neonHost = /^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*ap-southeast-1\.aws\.neon\.tech$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new Error("Native Preview のアプリと専用 DB の設定を確認できません。");

export function nativePreviewEnvironmentId(pr: number, generation: string, branchId: string): string {
  if (!Number.isSafeInteger(pr) || pr < 1 || pr > 2147483647 || !generationId.test(generation) || !neonBranchId.test(branchId)) {
    throw invalid();
  }
  return `mille-native-pr-${pr}-${sha256(`${generation}:${branchId}`)}`;
}

export function hasNativePreviewDatabaseBinding(environment: Environment): boolean {
  return environment.MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID !== undefined
    || environment.MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID !== undefined
    || environment.MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256 !== undefined;
}

export function nativePreviewApplication(environment: Environment) {
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID ?? "";
  const pr = environment.MILLE_NATIVE_PREVIEW_PR ?? "";
  const ref = environment.MILLE_NATIVE_PREVIEW_SOURCE_BRANCH ?? "";
  const sha = environment.MILLE_NATIVE_PREVIEW_SOURCE_SHA ?? "";
  const generation = environment.MILLE_NATIVE_PREVIEW_GENERATION ?? "";
  const branchId = environment.MILLE_NATIVE_PREVIEW_NEON_BRANCH_ID ?? "";
  const endpointId = environment.MILLE_NATIVE_PREVIEW_NEON_ENDPOINT_ID ?? "";
  const providerPr = environment.VERCEL_GIT_PULL_REQUEST_ID;
  if (environment.MILLE_NATIVE_PREVIEW_PHASE !== "application" || environment.AUTH_MODE !== "test"
    || (environment.MILLE_DB_MODE !== undefined && environment.MILLE_DB_MODE !== "hosted")
    || environment.MILLE_MEMORY_DATABASE_URL !== undefined || environment.MILLE_MEMORY_DATABASE_TOKEN !== undefined
    || environment.VERCEL !== "1" || environment.VERCEL_ENV !== "preview"
    || (environment.VERCEL_TARGET_ENV !== undefined && environment.VERCEL_TARGET_ENV !== "preview")
    || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)
    || environment.VERCEL_GIT_REPO_OWNER !== "tyask" || environment.VERCEL_GIT_REPO_SLUG !== "mille"
    || !pilotRef.test(ref) || ref !== environment.VERCEL_GIT_COMMIT_REF
    || !/^[a-f0-9]{40}$/.test(sha) || sha !== environment.VERCEL_GIT_COMMIT_SHA
    || !/^[1-9][0-9]*$/.test(pr) || (providerPr && providerPr !== pr)
    || !neonEndpointId.test(endpointId) || endpointId.endsWith("-pooler")) {
    throw invalid();
  }
  const environmentId = nativePreviewEnvironmentId(Number(pr), generation, branchId);

  const url = environment.MILLE_NATIVE_PREVIEW_DATABASE_URL ?? "";
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw invalid(); }
  const host = parsed.hostname;
  const directHost = host.replace(/^(ep-[a-z0-9-]+)-pooler\./, "$1.");
  if (parsed.protocol !== "postgresql:" || parsed.port || parsed.hash || parsed.pathname !== "/neondb"
    || parsed.username !== "neondb_owner" || !parsed.password || parsed.searchParams.getAll("sslmode").join() !== "require"
    || !neonHost.test(host) || directHost.split(".")[0] !== endpointId
    || sha256(directHost) !== environment.MILLE_NATIVE_PREVIEW_DATABASE_HOST_SHA256) {
    throw invalid();
  }

  return {
    deploymentId, pr, ref, sha, generation, endpointId,
    configuration: { mode: "hosted" as const, environment: "preview" as const, url, host, environmentId },
  };
}
