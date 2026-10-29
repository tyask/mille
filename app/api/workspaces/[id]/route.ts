import { handleWorkspaceApi, readWorkspaceJson } from "@/lib/server/workspace-http";
import { deleteWorkspaceSchema, renameWorkspaceSchema } from "@/lib/shared/workspace-schemas";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  return handleWorkspaceApi(request, async (repository) => {
    const { id } = await context.params;
    const { name } = await readWorkspaceJson(request, renameWorkspaceSchema);
    return repository.rename(id, name);
  }, { mutation: true });
}

export async function DELETE(request: Request, context: Context) {
  return handleWorkspaceApi(request, async (repository) => {
    const { id } = await context.params;
    const { confirmationName } = await readWorkspaceJson(request, deleteWorkspaceSchema);
    await repository.delete(id, confirmationName);
  }, { mutation: true, status: 204 });
}
