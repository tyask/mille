import { z } from "zod";
import { inspectDetachedNativeResource, NativeResourceInspectionError } from "./native-resource";

const environment = z.object({
  VERCEL_TOKEN: z.string().min(1),
  NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID: z.string().min(1),
  MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID: z.string().min(1),
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
    teamId: env.MILLE_PR_PREVIEW_VERCEL_TEAM_ID,
    storeId: env.MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID,
    integrationId: env.MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID,
    productId: env.MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID,
    neonProjectId: env.MILLE_PR_PREVIEW_NEON_PROJECT_ID,
    neonOrganizationId: env.MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID,
    templateBranchId: env.MILLE_PR_PREVIEW_NEON_TEMPLATE_ID,
    standingBranchId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID,
    standingEndpointId: env.MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID,
  };
  const result = await inspectDetachedNativeResource(config, {
    vercel(path) {
      const url = new URL(`https://api.vercel.com${path}`);
      url.searchParams.set("teamId", config.teamId);
      return readProvider(url, env.VERCEL_TOKEN);
    },
    neon(path) {
      return readProvider(new URL(`https://console.neon.tech/api/v2${path}`), env.NEON_API_KEY);
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof NativeResourceInspectionError
    ? error.message
    : "Native Preview のプロバイダー情報を照合できません。");
  process.exitCode = 1;
});
