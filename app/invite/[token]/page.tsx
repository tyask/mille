import Link from "next/link";
import { ZodError } from "zod";
import { LoginScreen } from "@/components/login-screen";
import InvitePanel from "@/components/invite-panel";
import { PageShell } from "@/components/page-shell";
import { SessionBoundary } from "@/components/session-boundary";
import { getAuthMode } from "@/lib/server/auth/auth-mode";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { DomainError, getWorkspaceRepository } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  if (!user) return <LoginScreen mode={getAuthMode()} callbackUrl={`/invite/${token}`} />;
  let invitation;
  try {
    const repository = await getWorkspaceRepository(user);
    invitation = await repository.previewInvite(token);
  } catch (error) {
    if (!(error instanceof DomainError) && !(error instanceof ZodError)) throw error;
    const message = error instanceof DomainError ? error.message : "招待リンクが正しくありません。リンクを確認してください。";
    return <PageShell signedIn><SessionBoundary userId={user.id}><section className="auth-card" aria-labelledby="invite-unavailable">
      <span className="card-eyebrow">WORKSPACE INVITATION</span>
      <h1 id="invite-unavailable">招待を確認できません</h1>
      <p className="form-message form-error" role="alert">{message}</p>
      <p className="card-description">ログイン中: {user.email}</p>
      <Link className="login-button test-button" href="/">ワークスペースへ戻る<span aria-hidden="true">→</span></Link>
    </section></SessionBoundary></PageShell>;
  }
  return <SessionBoundary userId={user.id}><InvitePanel token={token} initialInvitation={invitation} /></SessionBoundary>;
}
