import { z } from "zod";

export const nativePreviewStoreAccess = z.object({
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
  storeId: z.string().regex(/^store_[A-Za-z0-9]+$/),
  storeToken: z.string().trim().min(1),
});

export async function requestNativePreviewStore(
  input: z.input<typeof nativePreviewStoreAccess>, request: typeof fetch, signal: AbortSignal,
): Promise<Response> {
  const access = nativePreviewStoreAccess.safeParse(input);
  if (!access.success) throw new Error("Native Preview のストア読み取り設定を確認できません。");
  const { teamId, storeId, storeToken } = access.data;
  const url = new URL(`https://api.vercel.com/v1/storage/stores/${storeId}`);
  url.searchParams.set("teamId", teamId);
  try {
    return await request(url, {
      method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${storeToken}`, Accept: "application/json" },
    });
  } catch {
    throw new Error("Vercel ストアの応答を確認できません。");
  }
}
