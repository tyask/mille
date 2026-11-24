import type { SuggestionMode } from "../shared/suggestion-types";
import { matchesTestIdentity } from "../shared/test-users";
import type { AppUser } from "../shared/types";
import { isTestAuthEnabled, type AuthEnvironment } from "./auth/auth-mode";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import { databaseConfiguration, type DatabaseConfiguration } from "./database/environment";

export type SuggestionPreviewTarget = {
  environmentId: string;
  sourceSha: string;
  deploymentId: string;
};

export function canUseSuggestions(user: AppUser, environment: AuthEnvironment = process.env): boolean {
  return user.isEnabled && user.isTest && matchesTestIdentity(user) && isTestAuthEnabled(environment);
}

export function suggestionPreviewTarget(
  configuration: DatabaseConfiguration, environment: AuthEnvironment = process.env,
): SuggestionPreviewTarget | null {
  const sourceSha = environment.MILLE_SOURCE_SHA ?? "";
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID ?? "";
  if (!environment.OPENAI_API_KEY || environment.VERCEL !== "1" || environment.VERCEL_ENV !== "preview" || environment.AUTH_MODE !== "test"
    || (environment.VERCEL_TARGET_ENV !== undefined && environment.VERCEL_TARGET_ENV !== "preview")
    || configuration.mode !== "hosted" || configuration.environment !== "preview"
    || !/^mille-pr-[1-9][0-9]*$/.test(configuration.environmentId)
    || !/^[0-9a-f]{40}$/.test(sourceSha) || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) return null;
  return { environmentId: configuration.environmentId, sourceSha, deploymentId };
}

const enabledTarget = "id = true AND enabled AND environment_id = $1 AND source_sha = $2 AND deployment_id = $3";

export async function suggestionPreviewEnabled(query: Query, target: SuggestionPreviewTarget): Promise<boolean> {
  const { environmentId, sourceSha, deploymentId } = target;
  const rows = await query(`SELECT 1 FROM mille_suggestion_gateway_preview WHERE ${enabledTarget}`,
    [environmentId, sourceSha, deploymentId]);
  return rows.length === 1;
}

export async function reserveSuggestionRequest(query: Query, target: SuggestionPreviewTarget): Promise<boolean> {
  const { environmentId, sourceSha, deploymentId } = target;
  const rows = await query(`UPDATE mille_suggestion_gateway_preview SET request_count = request_count + 1
    WHERE ${enabledTarget} AND request_count < 10 RETURNING request_count`, [environmentId, sourceSha, deploymentId]);
  return rows.length === 1;
}

export async function getSuggestionMode(user: AppUser): Promise<SuggestionMode | null> {
  if (!canUseSuggestions(user)) return null;
  const target = suggestionPreviewTarget(databaseConfiguration());
  if (!target) return "sample";
  const { query } = await verifiedDatabaseQuery();
  return await suggestionPreviewEnabled(query, target) ? "openai" : "sample";
}
