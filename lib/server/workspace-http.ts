import { z } from "zod";
import type { AppUser } from "../shared/types";
import { DomainError, getWorkspaceRepository, type WorkspaceRepository } from "./workspaces";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Vary: "Cookie",
};
const maximumBodySize = 16_384;

export type WorkspaceApiDependencies = {
  getCurrentUser: () => Promise<AppUser | null>;
  getRepository: (user: AppUser) => Promise<WorkspaceRepository>;
};

export function assertWorkspaceSameOrigin(request: Request, environment: Readonly<Record<string, string | undefined>> = process.env): void {
  let expected: URL;
  try {
    expected = new URL(environment.AUTH_URL || request.url);
  } catch {
    throw new DomainError(403, "この操作はMilleの画面から実行してください。");
  }
  if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password
    || request.headers.get("origin") !== expected.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new DomainError(403, "この操作はMilleの画面から実行してください。");
  }
}

/** Bound bytes before decoding or parsing, including requests without Content-Length. */
export async function readWorkspaceJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new DomainError(400, "JSON形式で送信してください。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError(400, "入力内容を読み取れませんでした。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBodySize) {
        await reader.cancel();
        throw new DomainError(413, "入力が大きすぎます。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DomainError(400, "入力内容を読み取れませんでした。");
  }
  return schema.parse(value);
}

export async function handleWorkspaceApi(
  request: Request,
  operation: (repository: WorkspaceRepository) => Promise<unknown>,
  options: { mutation?: boolean; status?: number } = {},
  dependencies?: WorkspaceApiDependencies,
): Promise<Response> {
  try {
    if (options.mutation) assertWorkspaceSameOrigin(request);
    const getCurrentUser = dependencies?.getCurrentUser ?? (await import("./auth/current-user")).getCurrentUser;
    const user = await getCurrentUser();
    if (!user?.isEnabled) throw new DomainError(401, "ログインしてください。");
    const repository = await (dependencies?.getRepository ?? getWorkspaceRepository)(user);
    const result = await operation(repository);
    const status = options.status ?? 200;
    return status === 204 ? new Response(null, { status, headers: privateHeaders })
      : Response.json(result, { status, headers: privateHeaders });
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "入力内容を確認してください。" }, { status: 400, headers: privateHeaders });
    }
    // Do not expose SQL, session data, raw invitation tokens or stack traces.
    return Response.json({ error: "処理に失敗しました。時間をおいてもう一度お試しください。" }, { status: 500, headers: privateHeaders });
  }
}
