import { handleWorkspaceApi, readWorkspaceJson } from "@/lib/server/workspace-http";
import { workspaceInputSchema } from "@/lib/shared/workspace-schemas";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  return handleWorkspaceApi(request, (repository) => repository.list());
}

export async function POST(request: Request) {
  return handleWorkspaceApi(request, async (repository) => repository.create(await readWorkspaceJson(request, workspaceInputSchema)), { mutation: true, status: 201 });
}
