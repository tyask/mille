import { handleWorkspaceApi, readWorkspaceJson } from "@/lib/server/workspace-http";
import { invitationInputSchema } from "@/lib/shared/workspace-schemas";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleWorkspaceApi(request, async (repository) => {
    const { id } = await context.params;
    const { email } = await readWorkspaceJson(request, invitationInputSchema);
    return repository.invite(id, email);
  }, { mutation: true, status: 201 });
}
