import { handleWorkspaceApi } from "@/lib/server/workspace-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// This URL uses the invitation ID from the incoming list; the sibling accept route uses a raw link token.
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  return handleWorkspaceApi(request, async (repository) => repository.acceptInviteById((await context.params).token), { mutation: true });
}
