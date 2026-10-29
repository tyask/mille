import { handleWorkspaceApi } from "@/lib/server/workspace-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  return handleWorkspaceApi(request, async (repository) => repository.acceptInvite((await context.params).token), { mutation: true });
}
