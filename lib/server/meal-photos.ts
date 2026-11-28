import sharp from "sharp";
import {
  MEAL_PHOTO_CHUNK_BYTES, MEAL_PHOTO_MAX_BYTES, MEAL_PHOTO_MAX_EDGE, MEAL_PHOTO_MAX_PIXELS, MEAL_PHOTO_STORED_BYTE_LIMIT,
  mealPhotoIdSchema, mealPhotoSizeSchema, type MealPhoto,
} from "../shared/meal-photo-types";
import { mealIdSchema } from "../shared/meal-schemas";
import type { AppUser } from "../shared/types";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import { DomainError } from "./workspaces";

const photoErrorCodes = [
  "UNAUTHENTICATED", "NOT_FOUND", "INVALID_INPUT", "PHOTO_CONFLICT", "PHOTO_LIMIT", "PHOTO_INVALID", "BODY_TOO_LARGE",
] as const;
type MealPhotoErrorCode = typeof photoErrorCodes[number];

export class MealPhotoDomainError extends DomainError {
  constructor(status: number, public readonly code: MealPhotoErrorCode, message: string) {
    super(status, message);
    this.name = "MealPhotoDomainError";
  }
}

type PhotoResult<T> = { ok: true; data: T } | { ok: false; status: number; code: MealPhotoErrorCode; error: string };
type StagedPhoto = { photo: MealPhoto; generation: string; source: string | null };
type SanitizedPhoto = { bytes: Buffer; width: number; height: number };

export interface MealPhotoRepository {
  create(workspaceId: string, photoId: string, input: { size: number }): Promise<MealPhoto>;
  writeChunk(workspaceId: string, photoId: string, index: number, bytes: Uint8Array): Promise<void>;
  complete(workspaceId: string, photoId: string): Promise<MealPhoto>;
  read(workspaceId: string, photoId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: "image/webp" }>;
  remove(workspaceId: string, photoId: string): Promise<void>;
}

const readPhoto = "SELECT mille_meal_photo_read($1,$2,$3,$4,$5::uuid) AS result";
const writePhoto = "SELECT mille_meal_photo_write($1,$2,$3,$4,$5::uuid,$6::jsonb) AS result";

function invalidPhoto() {
  return new MealPhotoDomainError(422, "PHOTO_INVALID", "写真を読み込めませんでした。JPEG・PNG・WebP形式の写真を選んでください。");
}

function photoFormat(source: Uint8Array) {
  const header = Buffer.from(source.subarray(0, 12));
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "webp";
}

export async function sanitizeMealPhoto(source: Uint8Array): Promise<SanitizedPhoto> {
  if (source.byteLength > MEAL_PHOTO_MAX_BYTES) {
    throw new MealPhotoDomainError(413, "BODY_TOO_LARGE", "8 MiB以下の写真を選んでください。");
  }
  const expectedFormat = photoFormat(source);
  if (!expectedFormat) throw invalidPhoto();
  try {
    const image = sharp(source, { failOn: "warning", limitInputPixels: MEAL_PHOTO_MAX_PIXELS, sequentialRead: true });
    const { format, width, height, pages } = await image.metadata();
    if (format !== expectedFormat || !width || !height
      || width * height > MEAL_PHOTO_MAX_PIXELS || (pages ?? 1) !== 1) {
      throw invalidPhoto();
    }
    const normalized = image.autoOrient().resize({
      width: MEAL_PHOTO_MAX_EDGE, height: MEAL_PHOTO_MAX_EDGE, fit: "inside", withoutEnlargement: true,
    });
    for (const quality of [82, 65, 45]) {
      const { data, info } = await normalized.clone().webp({ quality }).toBuffer({ resolveWithObject: true });
      if (data.byteLength <= MEAL_PHOTO_STORED_BYTE_LIMIT) return { bytes: data, width: info.width, height: info.height };
    }
  } catch (error) {
    if (error instanceof MealPhotoDomainError) throw error;
    throw invalidPhoto();
  }
  throw invalidPhoto();
}

export function createMealPhotoRepository(query: Query, user: AppUser): MealPhotoRepository {
  async function execute<T>(
    statement: string, operation: string, workspaceId: string, photoId: string, ...parameters: string[]
  ): Promise<T> {
    if (!user.isEnabled) throw new MealPhotoDomainError(401, "UNAUTHENTICATED", "ログインしてください。");
    const rows = await query<{ result: PhotoResult<T> }>(statement, [
      user.id, user.email.trim().toLowerCase(), operation, mealIdSchema.parse(workspaceId),
      mealPhotoIdSchema.parse(photoId), ...parameters,
    ]);
    const result = rows[0]?.result;
    if (!result || typeof result.ok !== "boolean") throw new Error("Invalid photo database response");
    if (result.ok) return result.data;
    if (!Number.isInteger(result.status) || result.status < 400 || result.status > 499
      || !photoErrorCodes.includes(result.code) || typeof result.error !== "string") {
      throw new Error("Invalid photo database error");
    }
    throw new MealPhotoDomainError(result.status, result.code, result.error);
  }

  function write<T>(operation: string, workspaceId: string, photoId: string, payload: object = {}) {
    return execute<T>(writePhoto, operation, workspaceId, photoId, JSON.stringify(payload));
  }

  return {
    create: (workspaceId, photoId, { size }) => write<MealPhoto>("create", workspaceId, photoId, { size: mealPhotoSizeSchema.parse(size) }),
    async writeChunk(workspaceId, photoId, index, bytes) {
      if (!Number.isInteger(index) || index < 0 || index >= MEAL_PHOTO_MAX_BYTES / MEAL_PHOTO_CHUNK_BYTES
        || bytes.byteLength === 0 || bytes.byteLength > MEAL_PHOTO_CHUNK_BYTES) {
        throw new MealPhotoDomainError(400, "INVALID_INPUT", "写真の送信内容を確認してください。");
      }
      await write<null>("chunk", workspaceId, photoId, { index, bytes: Buffer.from(bytes).toString("base64") });
    },
    async complete(workspaceId, photoId) {
      const staged = await execute<StagedPhoto>(readPhoto, "assemble", workspaceId, photoId);
      if (staged.source === null) return staged.photo;
      let image: SanitizedPhoto;
      try {
        image = await sanitizeMealPhoto(Buffer.from(staged.source, "base64"));
      } catch (error) {
        // The invalid original is discarded immediately when possible. Its expiry is a fallback.
        await write<null>("discard", workspaceId, photoId, { generation: staged.generation }).catch(() => undefined);
        throw error;
      }
      return write<MealPhoto>("finish", workspaceId, photoId, {
        generation: staged.generation, width: image.width, height: image.height, bytes: image.bytes.toString("base64"),
      });
    },
    async read(workspaceId, photoId) {
      const source = await execute<string>(readPhoto, "read", workspaceId, photoId);
      return { bytes: Uint8Array.from(Buffer.from(source, "base64")), contentType: "image/webp" };
    },
    async remove(workspaceId, photoId) {
      await write<null>("discard", workspaceId, photoId);
    },
  };
}

export async function getMealPhotoRepository(user: AppUser): Promise<MealPhotoRepository> {
  const { query } = await verifiedDatabaseQuery();
  return createMealPhotoRepository(query, user);
}
