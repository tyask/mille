"use client";

import { useState } from "react";
import Link from "next/link";
import type { InvitationPreview, JoinedWorkspace } from "@/lib/shared/workspaces";
import { workspaceDate, workspaceRequest } from "./workspace-app";
import { Brand } from "./brand";
import { WorkspaceIcon as Icon } from "./workspace-icons";

export default function InvitePanel({ token, initialInvitation }: { token: string; initialInvitation: InvitationPreview }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joinedId, setJoinedId] = useState(initialInvitation.status === "ACCEPTED" ? initialInvitation.workspaceId : "");
  async function join() { if (busy) return; setBusy(true); setError(""); try { const result = await workspaceRequest<JoinedWorkspace>(`/api/invitations/${token}/accept`, "POST", {}); setJoinedId(result.workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "参加できませんでした。もう一度お試しください。"); } finally { setBusy(false); } }
  return <section className="ws-invite-page" aria-labelledby="ws-invite-title"><div className="ws-invite-brand"><Brand compact /></div><span className="ws-invite-page-icon"><Icon name={joinedId ? "check" : "users"} /></span><p className="ws-eyebrow">A SEAT AT YOUR TABLE</p><h1 id="ws-invite-title">{joinedId ? "一緒に使う場所が、できました。" : "いつもの食卓に、新しい仲間を。"}</h1><p className="ws-invite-description">{joinedId ? "共有ワークスペースへの参加が完了しています。" : `${initialInvitation.inviterName}さんから、共有ワークスペースへの招待です。`}</p><div className="ws-invited-space"><Icon name="users" /><strong>{initialInvitation.workspaceName}</strong><span>共有用ワークスペース</span></div><dl className="ws-invite-facts"><div><dt>招待先</dt><dd>{initialInvitation.email}</dd></div><div><dt>有効期限</dt><dd>{workspaceDate(initialInvitation.expiresAt)}（日本時間）</dd></div></dl><div className="ws-quiet-note"><Icon name="shield" /><p>参加すると、メンバーとしてワークスペースの設定を変更できます。</p></div>{error && <p className="ws-feedback ws-feedback-error" role="alert">{error}</p>}{joinedId ? <Link className="ws-button ws-button-primary ws-button-full" href={`/?workspace=${encodeURIComponent(joinedId)}`} prefetch={false}>ワークスペースを開く<Icon name="arrow" /></Link> : <button className="ws-button ws-button-primary ws-button-full" type="button" disabled={busy} onClick={() => void join()} data-testid="workspace-join-submit">{busy ? "参加しています…" : "参加する"}<Icon name="arrow" /></button>}<Link className="ws-invite-back" href="/" prefetch={false}>ワークスペース一覧へ戻る</Link></section>;
}
