import { z } from "zod";
import { detachedNativeVercelProject, detachedNativeVercelEnvironmentInventory } from "./native-pilot-vercel";
import { inspectNativePreviewNeonResource, NativeResourceInspectionError } from "./native-resource";

const environment = z.object({
  VERCEL_TOKEN: z.string().min(1),
  NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: z.string().min(1),
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: z.string().min(1),
});

async function readProvider(url: URL, token: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("プロバイダーの読み取りに失敗しました。");
  return response.json();
}

async function main() {
  const configured = environment.safeParse(process.env);
  if (!configured.success) throw new NativeResourceInspectionError("configuration");
  const env = configured.data;
  const config = {
    neonProjectId: env.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
    neonOrganizationId: env.MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID,
    templateBranchId: env.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID,
    standingBranchId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID,
    standingEndpointId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID,
  };
  const result = await inspectNativePreviewNeonResource(config,
    path => readProvider(new URL(`https://console.neon.tech/api/v2${path}`), env.NEON_API_KEY));
  const teamId = env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID;
  const vercelProjectId = env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID;
  const readVercel = (path: string) => {
    const url = new URL(`https://api.vercel.com${path}`);
    url.searchParams.set("teamId", teamId);
    return readProvider(url, env.VERCEL_TOKEN);
  };
  const [project, environmentVariables] = await Promise.all([
    readVercel(`/v9/projects/${vercelProjectId}`),
    readVercel(`/v10/projects/${vercelProjectId}/env?decrypt=false`),
  ]);
  if (!detachedNativeVercelProject(teamId, vercelProjectId).safeParse(project).success
    || !detachedNativeVercelEnvironmentInventory.safeParse(environmentVariables).success) {
    throw new Error("Vercel プロジェクトまたは Preview 環境変数の照合に失敗しました。");
  }
  console.log(JSON.stringify({ teamId, vercelProjectId, ...result }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof NativeResourceInspectionError
    ? error.message
    : "Native Preview のプロバイダー情報を照合できません。");
  process.exitCode = 1;
});
