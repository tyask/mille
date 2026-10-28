import { AuthenticatedHome } from "@/components/authenticated-home";
import { LoginScreen } from "@/components/login-screen";
import { getAuthMode } from "@/lib/server/auth/auth-mode";
import { getCurrentUser } from "@/lib/server/auth/current-user";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (user) return <AuthenticatedHome user={user} />;
  const error = typeof params.error === "string" ? params.error : undefined;
  return <LoginScreen mode={getAuthMode()} error={error} />;
}
