export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ app: "mille", sha: process.env.MILLE_SOURCE_SHA ?? null }, {
    headers: { "Cache-Control": "no-store" },
  });
}
