import { createHash, randomUUID } from "node:crypto";
import { mealPhotoAnalysisSchema } from "../shared/meal-photo-analysis";
import type { AppUser } from "../shared/types";
import { verifiedDatabaseQuery } from "./database/client";
import {
  analyzeMealPhotoWithOpenAI, OPENAI_MEAL_PHOTO_MODEL, OPENAI_MEAL_PHOTO_PROMPT_VERSION, sampleMealPhotoAnalysis,
} from "./meal-photo-analysis";
import { createMealPhotoRepository } from "./meal-photos";
import { canUseSuggestions, suggestionPreviewTarget } from "./suggestion-preview";
import { DomainError } from "./workspaces";

type AnalysisRow = {
  status: "unauthenticated" | "missing" | "ready" | "pending" | "limited" | "started" | "released";
  result?: unknown;
};

export async function analyzeMealPhoto(
  user: AppUser, workspaceId: string, photoId: string, signal?: AbortSignal,
) {
  if (!canUseSuggestions(user)) throw new DomainError(503, "写真の解析を利用できません。");
  const { query, configuration } = await verifiedDatabaseQuery();
  const { bytes } = await createMealPhotoRepository(query, user).read(workspaceId, photoId);
  const target = suggestionPreviewTarget(configuration);
  const enabled = target && (await query(
    "SELECT 1 FROM mille_meal_photo_preview WHERE id AND enabled AND environment_id = $1 AND source_sha = $2 AND deployment_id = $3",
    [target.environmentId, target.sourceSha, target.deploymentId],
  )).length === 1;
  const mode = enabled ? "openai" : "sample";
  const model = enabled ? OPENAI_MEAL_PHOTO_MODEL : "sample";
  const promptVersion = enabled ? OPENAI_MEAL_PHOTO_PROMPT_VERSION : "sample-ja-1";
  const lease = randomUUID();
  async function command(operation: "start" | "finish" | "fail", payload: object) {
    const rows = await query<{ result: AnalysisRow }>(
      "SELECT mille_meal_photo_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result",
      [user.id, user.email, operation, workspaceId, photoId, model, promptVersion, lease, JSON.stringify(payload)],
    );
    const response = rows[0]?.result;
    if (response?.status === "missing") throw new DomainError(404, "写真が見つかりません。");
    if (response?.status === "unauthenticated") throw new DomainError(401, "ログインしてください。");
    if (response?.status === "pending") throw new DomainError(409, "写真を解析中です。少し待ってからお試しください。");
    if (response?.status === "limited") throw new DomainError(429, "写真解析の試験回数の上限に達しました。");
    if (!response) throw new Error("Missing meal photo analysis result");
    return response;
  }
  const started = await command("start", {
    ...(enabled ? target : null),
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (started.status === "ready") return { result: mealPhotoAnalysisSchema.parse(started.result), mode };
  if (started.status !== "started") throw new Error("Invalid meal photo analysis state");
  try {
    const result = enabled
      ? await analyzeMealPhotoWithOpenAI(bytes, { getApiKey: () => process.env.OPENAI_API_KEY, signal })
      : sampleMealPhotoAnalysis();
    const saved = await command("finish", result);
    if (saved.status !== "ready") throw new Error("Could not save meal photo analysis");
    return { result: mealPhotoAnalysisSchema.parse(saved.result), mode };
  } catch (error) {
    await command("fail", {}).catch(() => undefined);
    throw error;
  }
}
