import { getCurrentUser } from "@/lib/server/auth/current-user";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Vary: "Cookie",
};

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "認証が必要です。" }, { status: 401, headers });
  return Response.json({ user: { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl } }, { headers });
}
