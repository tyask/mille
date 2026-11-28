import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mealIdSchema } from "../shared/meal-schemas";
import { MEAL_PHOTO_CHUNK_BYTES, mealPhotoIdSchema, mealPhotoSizeSchema } from "../shared/meal-photo-types";
import type { AppUser } from "../shared/types";
import { analyzeMealPhoto } from "./meal-photo-analysis-service";
import { MealPhotoAnalysisError } from "./meal-photo-analysis";
import { getMealPhotoRepository, MealPhotoDomainError } from "./meal-photos";
import { assertWorkspaceSameOrigin, privateApiHeaders, readWorkspaceJson } from "./workspace-http";
import { DomainError } from "./workspaces";

const createPhoto = z.strictObject({ photoId: mealPhotoIdSchema, size: mealPhotoSizeSchema });
const chunkIndex = z.string().regex(/^[0-7]$/u).transform(Number);
const statusCodes: Readonly<Record<number, string>> = {
  400: "INVALID_INPUT", 401: "UNAUTHENTICATED", 403: "ORIGIN_REJECTED", 404: "NOT_FOUND",
  409: "PHOTO_CONFLICT", 413: "BODY_TOO_LARGE", 429: "PHOTO_LIMIT", 503: "PHOTO_ANALYSIS_UNAVAILABLE",
};

function failure(status: number, code: string, error: string) {
  return Response.json({ error, code, requestId: randomUUID() }, { status, headers: privateApiHeaders });
}

async function readChunk(request: Request) {
  if (request.headers.get("content-type") !== "application/octet-stream") {
    throw new DomainError(400, "画像データの形式を確認してください。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError(400, "画像データを読み取れませんでした。");
  const bytes = new Uint8Array(MEAL_PHOTO_CHUNK_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) {
        void reader.cancel().catch(() => {});
        throw new DomainError(413, "画像データが大きすぎます。");
      }
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new DomainError(400, "画像データが空です。");
  return bytes.subarray(0, size);
}

async function handle(
  request: Request,
  workspaceId: string,
  operation: (user: AppUser, workspaceId: string) => Promise<Response>,
) {
  try {
    if (request.method !== "GET") assertWorkspaceSameOrigin(request);
    const user = await (await import("./auth/current-user")).getCurrentUser();
    if (!user?.isEnabled) return failure(401, "UNAUTHENTICATED", "ログインしてください。");
    return await operation(user, mealIdSchema.parse(workspaceId));
  } catch (error) {
    if (error instanceof MealPhotoDomainError) return failure(error.status, error.code, error.message);
    if (error instanceof MealPhotoAnalysisError) {
      return failure(error.code === "timeout" ? 504 : 502, "PHOTO_ANALYSIS_FAILED", error.message);
    }
    if (error instanceof DomainError && statusCodes[error.status]) {
      return failure(error.status, statusCodes[error.status], error.message);
    }
    if (error instanceof z.ZodError) return failure(400, "INVALID_INPUT", "写真の入力内容を確認してください。");
    return failure(500, "INTERNAL_ERROR", "処理に失敗しました。時間をおいてもう一度お試しください。");
  }
}

export const mealPhotoHandlers = {
  create: (request: Request, workspace: string) => handle(request, workspace, async (user, workspaceId) => {
    const { photoId, size } = await readWorkspaceJson(request, createPhoto);
    const photo = await (await getMealPhotoRepository(user)).create(workspaceId, photoId, { size });
    return Response.json({ photo }, { status: 201, headers: privateApiHeaders });
  }),
  chunk: (request: Request, workspace: string, photo: string, index: string) =>
    handle(request, workspace, async (user, workspaceId) => {
      const photoId = mealPhotoIdSchema.parse(photo);
      const part = chunkIndex.parse(index);
      const bytes = await readChunk(request);
      await (await getMealPhotoRepository(user)).writeChunk(workspaceId, photoId, part, bytes);
      return new Response(null, { status: 204, headers: privateApiHeaders });
    }),
  complete: (request: Request, workspace: string, photo: string) => handle(request, workspace, async (user, workspaceId) => {
    const photoId = mealPhotoIdSchema.parse(photo);
    const saved = await (await getMealPhotoRepository(user)).complete(workspaceId, photoId);
    return Response.json({ photo: saved }, { headers: privateApiHeaders });
  }),
  read: (request: Request, workspace: string, photo: string) => handle(request, workspace, async (user, workspaceId) => {
    const { bytes, contentType } = await (await getMealPhotoRepository(user)).read(workspaceId, mealPhotoIdSchema.parse(photo));
    return new Response(bytes, {
      headers: { ...privateApiHeaders, "Content-Type": contentType, "X-Content-Type-Options": "nosniff" },
    });
  }),
  remove: (request: Request, workspace: string, photo: string) => handle(request, workspace, async (user, workspaceId) => {
    await (await getMealPhotoRepository(user)).remove(workspaceId, mealPhotoIdSchema.parse(photo));
    return new Response(null, { status: 204, headers: privateApiHeaders });
  }),
  analyze: (request: Request, workspace: string, photo: string) => handle(request, workspace, async (user, workspaceId) => {
    const photoId = mealPhotoIdSchema.parse(photo);
    const { result, mode } = await analyzeMealPhoto(user, workspaceId, photoId, request.signal);
    return Response.json(result, { headers: { ...privateApiHeaders, "X-Mille-Photo-Analysis": mode } });
  }),
};
