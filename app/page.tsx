import WorkspaceApp from "@/components/workspace-app";
import { SessionBoundary } from "@/components/session-boundary";
import { LoginScreen } from "@/components/login-screen";
import { readMealLocation } from "@/components/meals/meal-location";
import { getAuthMode } from "@/lib/server/auth/auth-mode";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { getWorkspaceState } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (user) {
    const initialState = await getWorkspaceState(user);
    const initialWorkspaceId = typeof params.workspace === "string" ? params.workspace : undefined;
    const initialLocation = readMealLocation(key => {
      const value = params[key];
      return typeof value === "string" ? value : undefined;
    });
    return <SessionBoundary userId={user.id}><WorkspaceApp user={user} initialState={initialState} initialWorkspaceId={initialWorkspaceId} initialLocation={initialLocation} /></SessionBoundary>;
  }
  const error = typeof params.error === "string" ? params.error : undefined;
  return <LoginScreen mode={getAuthMode()} error={error} />;
}
