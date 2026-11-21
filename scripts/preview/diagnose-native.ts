import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nativeVercelProject, nativeVercelDeploymentInventory, nativeVercelEnvironmentInventory,
  hasDetachedPreviewEnvironments } from "./native-pilot-vercel";
import { inspectDetachedNativeResource, NativeResourceInspectionError } from "./native-resource";
import { neonPreviewBranchDetails, neonPreviewBranchEndpoints, neonPreviewBranchInventory,
  neonPreviewConnectionQuery, neonPreviewConnectionUri, matchesNeonPreviewConnection } from "./neon";

const environment = z.object({
  VERCEL_TOKEN: z.string().min(1),
  NEON_API_KEY: z.string().min(1),
  MILLE_PR_PREVIEW_VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  MILLE_NATIVE_PREVIEW_VERCEL_STORE_ID: z.string().regex(/^store_[A-Za-z0-9]+$/),
  MILLE_NATIVE_PREVIEW_VERCEL_INTEGRATION_ID: z.string().regex(/^icfg_[A-Za-z0-9]+$/),
  MILLE_NATIVE_PREVIEW_VERCEL_PRODUCT_ID: z.string().regex(/^iap_[A-Za-z0-9]+$/),
  MILLE_PR_PREVIEW_NEON_PROJECT_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  MILLE_NATIVE_PREVIEW_NEON_ORGANIZATION_ID: z.string().regex(/^org-[a-z0-9][a-z0-9-]{0,55}$/),
  MILLE_PR_PREVIEW_NEON_TEMPLATE_ID: z.string().regex(/^br-[a-z0-9][a-z0-9-]{0,56}$/),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: z.string().regex(/^br-[a-z0-9][a-z0-9-]{0,56}$/),
  MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: z.string().regex(/^ep-[a-z0-9][a-z0-9-]{0,56}$/),
});

const resourceChecks = {
  configuration: "診断の入力設定",
  store: "Vercel ストア",
  project: "Neon プロジェクト",
  branch: "Neon ブランチ一覧と既定ブランチ",
  endpoint: "Neon エンドポイント一覧",
  database: "Neon テンプレート DB",
  role: "Neon テンプレート所有ロール",
} as const;

type Check = { name: string; ok: boolean; status?: number };

async function readMetadata(
  check: Check, url: URL, token: string, request: typeof fetch, expectedStatus = 200,
): Promise<unknown> {
  const response = await request(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  check.status = response.status;
  if (response.status !== expectedStatus) throw new Error("診断の HTTP 状態が一致しません。");
  return expectedStatus === 404 ? null : response.json();
}

async function probe(
  name: string, url: URL, token: string, request: typeof fetch, schema: z.ZodType, expectedStatus = 200,
): Promise<Check> {
  const check: Check = { name, ok: false };
  try {
    const response = await readMetadata(check, url, token, request, expectedStatus);
    check.ok = schema.safeParse(response).success;
  } catch {
    // Report the fixed check name and the HTTP status captured before parsing.
  }
  return check;
}

export async function diagnoseNativePreview(
  input: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch,
): Promise<readonly Check[]> {
  const parsed = environment.safeParse(input);
  if (!parsed.success) return [{ name: resourceChecks.configuration, ok: false }];
  const env = parsed.data;
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
  if (config.templateBranchId === config.standingBranchId || config.standingEndpointId.endsWith("-pooler")) {
    return [{ name: resourceChecks.configuration, ok: false }];
  }

  const vercelUrl = (path: string) => {
    const url = new URL(`https://api.vercel.com${path}`);
    url.searchParams.set("teamId", config.teamId);
    return url;
  };
  const neonUrl = (path: string) => new URL(`https://console.neon.tech/api/v2${path}`);
  const checks = new Map<keyof typeof resourceChecks, Check>();
  const neonProject = `/projects/${config.neonProjectId}`;
  const template = `${neonProject}/branches/${config.templateBranchId}`;
  const routes = new Map<string, keyof typeof resourceChecks>([
    [`/v1/storage/stores/${config.storeId}`, "store"],
    [neonProject, "project"],
    [`${neonProject}/branches?limit=100`, "branch"],
    [`${neonProject}/endpoints`, "endpoint"],
    [`${template}/databases`, "database"],
    [`${template}/roles`, "role"],
  ]);
  async function inspectResource(path: string) {
    const stage = routes.get(path);
    if (!stage) throw new NativeResourceInspectionError("configuration");
    const check = { name: resourceChecks[stage], ok: false };
    checks.set(stage, check);
    const store = stage === "store";
    const url = store ? vercelUrl(path) : neonUrl(path);
    const result = await readMetadata(check, url, store ? env.VERCEL_TOKEN : env.NEON_API_KEY, request);
    if (stage === "branch" && !neonPreviewBranchInventory.safeParse(result).success) {
      throw new NativeResourceInspectionError(stage);
    }
    check.ok = true;
    return result;
  }
  const neonChecks: Promise<Check>[] = [];
  try {
    const verified = await inspectDetachedNativeResource(config, { vercel: inspectResource, neon: inspectResource });
    if (verified.templateIsDefault) throw new NativeResourceInspectionError("branch");
    const roots = [
      { label: "テンプレート", name: "mille-pr-template", id: verified.branchId, isDefault: false,
        endpointId: verified.endpointId, host: verified.host },
      { label: "常設", name: "main", id: verified.standingBranchId, isDefault: true,
        endpointId: verified.standingEndpointId, host: verified.standingHost },
    ];
    for (const root of roots) {
      const path = `${neonProject}/branches/${root.id}`;
      neonChecks.push(
        probe(`Neon ${root.label}ブランチ詳細`, neonUrl(path), env.NEON_API_KEY, request,
          neonPreviewBranchDetails.refine(({ branch }) => branch.id === root.id && branch.project_id === config.neonProjectId
            && branch.name === root.name && branch.default === root.isDefault && branch.parent_id == null
            && branch.pending_state == null && branch.current_state === "ready")),
        probe(`Neon ${root.label}ブランチのエンドポイント`, neonUrl(`${path}/endpoints`), env.NEON_API_KEY, request,
          neonPreviewBranchEndpoints.refine(({ endpoints }) => {
            const writable = endpoints.filter(endpoint => endpoint.type === "read_write");
            return endpoints.every(endpoint => endpoint.project_id === config.neonProjectId && endpoint.branch_id === root.id)
              && writable.length === 1 && !writable[0].disabled && writable[0].id === root.endpointId
              && writable[0].host === root.host;
          })),
      );
    }
    if ((await Promise.all(neonChecks)).every(check => check.ok)) {
      const params = neonPreviewConnectionQuery(verified.branchId, verified.endpointId, verified.database, verified.role);
      const schema = neonPreviewConnectionUri.refine(({ uri }) => URL.canParse(uri)
        && matchesNeonPreviewConnection(new URL(uri), verified.host, verified.database, verified.role));
      neonChecks.push(probe("Neon テンプレート接続情報", neonUrl(`${neonProject}/connection_uri?${params}`),
        env.NEON_API_KEY, request, schema));
    }
  } catch (error) {
    const stage = error instanceof NativeResourceInspectionError ? error.stage : "configuration";
    const check = checks.get(stage) ?? { name: resourceChecks[stage], ok: false };
    check.ok = false;
    checks.set(stage, check);
  }

  const projectId = env.MILLE_PR_PREVIEW_VERCEL_PROJECT_ID;
  const probeVercel = (name: string, path: string, schema: z.ZodType, status?: number) =>
    probe(name, vercelUrl(path), env.VERCEL_TOKEN, request, schema, status);
  const supplementalChecks = await Promise.all([
    ...neonChecks,
    probeVercel("Vercel プロジェクト", `/v9/projects/${projectId}`, nativeVercelProject.refine(project =>
      project.id === projectId && project.accountId === config.teamId && hasDetachedPreviewEnvironments(project.env ?? []))),
    probeVercel("Vercel 環境変数メタデータ", `/v10/projects/${projectId}/env?decrypt=false`,
      nativeVercelEnvironmentInventory.refine(({ envs, pagination }) => hasDetachedPreviewEnvironments(envs)
        && (pagination?.count === undefined || pagination.count === envs.length))),
    probeVercel("Vercel デプロイ一覧の先頭ページ", `/v6/deployments?projectId=${projectId}&limit=100`,
      nativeVercelDeploymentInventory.refine(({ deployments, pagination }) => pagination.count === deployments.length
        && deployments.every(deployment => deployment.projectId === projectId)
        && new Set(deployments.map(deployment => deployment.uid)).size === deployments.length)),
    ...(["a", "b"] as const).map(pilot => probeVercel(`Vercel 試験エイリアス ${pilot.toUpperCase()}`,
      `/v4/aliases/mille-git-codex-native-preview-pilot-${pilot}-fumin1.vercel.app`, z.null(), 404)),
  ]);
  return [...checks.values(), ...supplementalChecks];
}

export function formatNativePreviewDiagnosis(checks: readonly Check[]): string {
  return checks.map(({ name, ok, status }) => `- ${name} ${ok ? "確認" : "失敗"}${status === undefined ? "" : ` (HTTP ${status})`}`).join("\n");
}

async function main() {
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== "tyask/mille" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_WORKFLOW_REF !== "tyask/mille/.github/workflows/native-preview-diagnosis.yml@refs/heads/main") {
    throw new Error("信頼済み main の手動実行が必要です。");
  }
  const checks = await diagnoseNativePreview(env);
  const result = formatNativePreviewDiagnosis(checks);
  console.log(result);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${result}\n`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Native Preview 診断を実行できません。");
    process.exitCode = 1;
  });
}
