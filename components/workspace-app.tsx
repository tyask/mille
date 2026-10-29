"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { signOut } from "next-auth/react";
import type { AppUser } from "@/lib/shared/types";
import type { IssuedInvitation, JoinedWorkspace, Workspace, WorkspaceState, WorkspaceType } from "@/lib/shared/workspaces";
import { Brand } from "./brand";
import { WorkspaceIcon as Icon } from "./workspace-icons";

export async function workspaceRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let result: unknown;
  if (response.status !== 204) {
    try { result = await response.json(); } catch { throw new Error("応答を確認できませんでした。時間をおいてお試しください。"); }
  }
  if (!response.ok) throw new Error(typeof result === "object" && result !== null && "error" in result && typeof result.error === "string" ? result.error : "処理できませんでした。時間をおいてお試しください。");
  return result as T;
}

export function workspaceDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tokyo" }).format(new Date(value));
}

function Avatar({ name, small = false, index = 0 }: { name: string; small?: boolean; index?: number }) {
  return <span className={`ws-avatar ws-avatar-${index % 3}${small ? " ws-avatar-small" : ""}`} aria-hidden="true">{Array.from(name.trim())[0] || "M"}</span>;
}

function SpaceIcon({ type }: { type: WorkspaceType }) {
  return <Icon name={type === "SHARED" ? "users" : "user"} />;
}

type Mutation = <T>(operation: () => Promise<T>, success: string, preferredId?: (result: T) => string | undefined) => Promise<T | undefined>;
type DialogState = { kind: "create" } | { kind: "rename" | "delete" | "invite"; workspace: Workspace };

function Dialog({ title, children, busy, error, onClose, testId }: { title: string; children: ReactNode; busy: boolean; error: string; onClose: () => void; testId: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="ws-dialog" ref={ref} aria-labelledby="ws-dialog-title" data-testid={testId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="ws-dialog-heading"><h2 id="ws-dialog-title">{title}</h2><button className="ws-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="閉じる"><Icon name="close" /></button></div>
    {error && <p className="ws-feedback ws-feedback-error" role="alert">{error}</p>}{children}
  </dialog>;
}

function CreateDialog({ busy, error, onClose, mutate }: { busy: boolean; error: string; onClose: () => void; mutate: Mutation }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<WorkspaceType>("SHARED");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await mutate(() => workspaceRequest<Workspace>("/api/workspaces", "POST", { name, type }), "ワークスペースを作成しました。", (workspace) => workspace.id);
    if (result) onClose();
  }
  return <Dialog title="新しいワークスペース" busy={busy} error={error} onClose={onClose} testId="workspace-create-dialog">
    <p className="ws-dialog-description">自分だけで、家族や大切な人と。食卓を囲む仲間に合わせて選びましょう。</p>
    <form onSubmit={submit}><fieldset className="ws-type-options"><legend>ワークスペースの種類</legend>{(["PERSONAL", "SHARED"] as const).map((value) => <label key={value} className={`ws-type-option${type === value ? " is-selected" : ""}`}><input type="radio" name="workspace-type" value={value} data-testid={value === "SHARED" ? "workspace-create-type-shared" : "workspace-create-type-personal"} checked={type === value} onChange={() => setType(value)} disabled={busy} /><SpaceIcon type={value} /><strong>{value === "PERSONAL" ? "個人用" : "共有用"}</strong><span>{value === "PERSONAL" ? "自分だけで使う場所" : "招待した仲間と使う場所"}</span></label>)}</fieldset>
      <label className="ws-label" htmlFor="ws-create-name">ワークスペース名</label><input className="ws-input" id="ws-create-name" data-testid="workspace-create-name" name="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} autoFocus placeholder={type === "SHARED" ? "例：わが家の食卓" : "例：わたしの食卓"} />
      <p className="ws-hint">80文字以内で入力してください。名前はあとから変更できます。</p><div className="ws-dialog-actions"><button className="ws-button ws-button-secondary" type="button" onClick={onClose} disabled={busy}>キャンセル</button><button className="ws-button ws-button-primary" disabled={busy || !name.trim()} data-testid="workspace-create-submit"><Icon name="plus" />作成する</button></div>
    </form>
  </Dialog>;
}

function RenameDialog({ workspace, busy, error, onClose, mutate }: { workspace: Workspace; busy: boolean; error: string; onClose: () => void; mutate: Mutation }) {
  const [name, setName] = useState(workspace.name);
  async function submit(event: FormEvent) { event.preventDefault(); const result = await mutate(() => workspaceRequest<Workspace>(`/api/workspaces/${workspace.id}`, "PATCH", { name }), "ワークスペース名を変更しました。"); if (result) onClose(); }
  return <Dialog title="ワークスペース名を変更" busy={busy} error={error} onClose={onClose} testId="workspace-rename-dialog"><form onSubmit={submit}><label className="ws-label" htmlFor="ws-rename-name">ワークスペース名</label><input className="ws-input" id="ws-rename-name" data-testid="workspace-rename-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus disabled={busy} /><p className="ws-hint">共有メンバーにも、新しい名前が表示されます。</p><div className="ws-dialog-actions"><button className="ws-button ws-button-secondary" type="button" onClick={onClose} disabled={busy}>キャンセル</button><button className="ws-button ws-button-primary" disabled={busy || !name.trim() || name.trim() === workspace.name} data-testid="workspace-rename-submit">変更を保存</button></div></form></Dialog>;
}

function DeleteDialog({ workspace, busy, error, onClose, mutate }: { workspace: Workspace; busy: boolean; error: string; onClose: () => void; mutate: Mutation }) {
  const [confirmationName, setConfirmationName] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); const result = await mutate(async () => { await workspaceRequest(`/api/workspaces/${workspace.id}`, "DELETE", { confirmationName }); return true; }, "ワークスペースを削除しました。"); if (result) onClose(); }
  return <Dialog title="ワークスペースを削除" busy={busy} error={error} onClose={onClose} testId="workspace-delete-dialog"><div className="ws-danger-note"><Icon name="trash" /><p>「{workspace.name}」とすべての関連データを削除します。この操作は取り消せません。共有メンバーもアクセスできなくなります。</p></div><form onSubmit={submit}><label className="ws-label" htmlFor="ws-delete-confirmation">確認のため「{workspace.name}」と入力してください</label><input className="ws-input" id="ws-delete-confirmation" data-testid="workspace-delete-confirmation" value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} disabled={busy} autoFocus autoComplete="off" /><div className="ws-dialog-actions"><button className="ws-button ws-button-secondary" type="button" onClick={onClose} disabled={busy}>キャンセル</button><button className="ws-button ws-button-danger" disabled={busy || confirmationName !== workspace.name} data-testid="workspace-delete-submit"><Icon name="trash" />削除する</button></div></form></Dialog>;
}

function InviteDialog({ workspace, busy, error, onClose, mutate }: { workspace: Workspace; busy: boolean; error: string; onClose: () => void; mutate: Mutation }) {
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await mutate(() => workspaceRequest<IssuedInvitation>(`/api/workspaces/${workspace.id}/invitations`, "POST", { email }), "招待リンクを発行しました。");
    if (result) { setIssued({ url: `${window.location.origin}/invite/${result.token}`, expiresAt: result.invitation.expiresAt }); setCopied(false); }
  }
  async function copy() { if (!issued) return; try { await navigator.clipboard.writeText(issued.url); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }
  return <Dialog title="メンバーを招待" busy={busy} error={error} onClose={onClose} testId="workspace-invite-dialog"><p className="ws-dialog-description">「{workspace.name}」に、一緒に使う相手を招待します。指定したメールアドレスでログインした方だけが参加できます。</p><form onSubmit={submit}><label className="ws-label" htmlFor="ws-invite-email">相手のメールアドレス</label><input className="ws-input" id="ws-invite-email" data-testid="workspace-invite-email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setIssued(null); }} required maxLength={254} placeholder="partner@example.com" disabled={busy} autoFocus /><p className="ws-hint">同じ宛先に再発行すると、以前のリンクは無効になります。</p>{!issued && <button className="ws-button ws-button-primary ws-button-full" disabled={busy || !email.trim()} data-testid="workspace-invite-submit"><Icon name="link" />招待リンクを発行</button>}</form>{issued && <div className="ws-invite-result"><p className="ws-success-label"><Icon name="check" />招待リンクを発行しました</p><label className="ws-sr-only" htmlFor="ws-invitation-link">招待リンク</label><input className="ws-input" id="ws-invitation-link" data-testid="workspace-invitation-link" value={issued.url} readOnly onFocus={(event) => event.target.select()} /><button className="ws-button ws-button-primary ws-button-full" type="button" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"} />{copied ? "コピーしました" : "リンクをコピー"}</button><p className="ws-hint">有効期限：{workspaceDate(issued.expiresAt)}（日本時間）</p>{copyError && <p className="ws-inline-error" role="alert">コピーできませんでした。リンクを選択してコピーしてください。</p>}</div>}<div className="ws-quiet-note"><Icon name="mail" /><p>メールは自動送信されません。リンクをコピーして、相手に送ってください。</p></div></Dialog>;
}

export default function WorkspaceApp({ user, initialState, initialWorkspaceId }: { user: AppUser; initialState: WorkspaceState; initialWorkspaceId?: string }) {
  const [state, setState] = useState(initialState);
  const [activeId, setActiveId] = useState(initialWorkspaceId || initialState.workspaces[0]?.id || "");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const requestSequence = useRef(0);
  const selectionSequence = useRef(0);
  const mutationPending = useRef(false);
  const active = state.workspaces.find((workspace) => workspace.id === activeId) || state.workspaces[0];
  const storageKey = `mille:workspace:${user.id}`;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let stored = initialWorkspaceId;
      if (!stored) {
        try { stored = localStorage.getItem(storageKey) || undefined; } catch { /* Optional preference storage. */ }
      }
      if (stored && initialState.workspaces.some((workspace) => workspace.id === stored)) {
        setActiveId(stored);
        try { localStorage.setItem(storageKey, stored); } catch { /* Optional preference storage. */ }
        if (initialWorkspaceId) {
          const url = new URL(window.location.href);
          url.searchParams.delete("workspace");
          window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [initialState.workspaces, initialWorkspaceId, storageKey]);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 700px)");
    function closeOnDesktop(event: MediaQueryListEvent) { if (!event.matches) setMobileOpen(false); }
    mobileViewport.addEventListener("change", closeOnDesktop);
    return () => mobileViewport.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus = document.activeElement;
    const closeButton = document.getElementById("ws-mobile-close");
    closeButton?.focus();
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") setMobileOpen(false); }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [mobileOpen]);

  function selectWorkspace(id: string) { selectionSequence.current += 1; setActiveId(id); setMobileOpen(false); try { localStorage.setItem(storageKey, id); } catch { /* Optional browser preference. */ } }
  function openDialog(next: DialogState) { if (refreshing || loggingOut) return; setError(""); setNotice(""); setDialog(next); setMobileOpen(false); }
  function closeDialog() { if (!mutationPending.current) { setDialog(null); } }
  async function reload(preferredId?: string, selectedAtStart = selectionSequence.current) {
    const sequence = ++requestSequence.current;
    const next = await workspaceRequest<WorkspaceState>("/api/workspaces");
    if (sequence !== requestSequence.current) return;
    setState(next);
    if (preferredId && selectedAtStart === selectionSequence.current && next.workspaces.some((workspace) => workspace.id === preferredId)) selectWorkspace(preferredId);
  }
  const mutate: Mutation = async (operation, success, preferredId) => {
    if (mutationPending.current || refreshing || loggingOut) return undefined;
    mutationPending.current = true; setBusy(true); setError(""); setNotice("");
    const selectedAtStart = selectionSequence.current;
    let saved = false;
    let result;
    try { result = await operation(); saved = true; await reload(preferredId?.(result), selectedAtStart); setNotice(success); return result; }
    catch (cause) { setError(saved ? "保存は完了しましたが、最新情報を取得できませんでした。「更新」で再取得してください。" : cause instanceof Error ? cause.message : "処理できませんでした。もう一度お試しください。"); return saved ? result : undefined; }
    finally { mutationPending.current = false; setBusy(false); }
  };
  async function refresh() { if (refreshing || mutationPending.current || loggingOut) return; setRefreshing(true); setError(""); setNotice(""); try { await reload(); setNotice("最新の情報に更新しました。"); } catch { setError("最新情報を取得できませんでした。時間をおいて再度お試しください。"); } finally { setRefreshing(false); } }
  async function logout() {
    if (loggingOut || mutationPending.current) return;
    setLoggingOut(true); setError("");
    try { await signOut({ redirect: false }); try { localStorage.setItem("mille:auth-change", String(Date.now())); } catch { /* Optional browser storage. */ } window.location.replace("/"); }
    catch { setError("ログアウトできませんでした。もう一度お試しください。"); setLoggingOut(false); }
  }

  return <div className="workspace-app" data-testid="authenticated-home">
    {mobileOpen && <button className="ws-sidebar-backdrop" aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)} />}
    <aside className={`ws-sidebar${mobileOpen ? " is-open" : ""}`} aria-label="ワークスペースメニュー" id="ws-sidebar"><Brand compact /><button id="ws-mobile-close" className="ws-icon-button ws-mobile-close" type="button" aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)}><Icon name="close" /></button><div className="ws-sidebar-label">YOUR SPACES<span>{state.workspaces.length}</span></div><nav className="ws-space-nav" aria-label="ワークスペースを切り替え">{state.workspaces.map((workspace) => <button type="button" key={workspace.id} className={`ws-space-nav-item${active?.id === workspace.id ? " is-active" : ""}`} aria-current={active?.id === workspace.id ? "page" : undefined} data-testid="workspace-switch" data-workspace-id={workspace.id} onClick={() => selectWorkspace(workspace.id)}><SpaceIcon type={workspace.type} /><span>{workspace.name}</span>{active?.id === workspace.id && <i aria-hidden="true" />}</button>)}</nav><button className="ws-sidebar-create" type="button" onClick={() => openDialog({ kind: "create" })} disabled={busy || refreshing || loggingOut}><Icon name="plus" />ワークスペースを作成</button><div className="ws-sidebar-bottom"><div className="ws-sidebar-note"><Icon name="leaf" /><p>ひとりの食卓も、みんなの食卓も。<br />大切な場所を、ひとつずつ。</p></div><div className="ws-account"><Avatar name={user.name} small /><div><strong>{user.name}</strong><span data-testid="authenticated-user-email" title={user.email}>{user.email}</span></div></div><button className="ws-logout" type="button" onClick={() => void logout()} disabled={busy || refreshing || loggingOut} aria-label="ログアウト"><Icon name="logout" />{loggingOut ? "ログアウト中…" : "ログアウト"}</button></div></aside>
    <div className="ws-main-shell" inert={mobileOpen}><header className="ws-topbar"><button className="ws-mobile-menu" type="button" aria-label="ワークスペースメニューを開く" aria-expanded={mobileOpen} aria-controls="ws-sidebar" onClick={() => setMobileOpen(!mobileOpen)}><Icon name="menu" /><span>mille.</span></button><div className="ws-breadcrumb"><span>mille</span><span aria-hidden="true">/</span><span>ワークスペース</span></div><div className="ws-topbar-right"><span className="ws-private-label"><Icon name="shield" />自分たちだけのスペース</span><button className="ws-refresh" data-testid="workspace-refresh" type="button" aria-label="最新情報に更新" onClick={() => void refresh()} disabled={busy || refreshing || loggingOut}><Icon name="refresh" className={refreshing ? "ws-spin" : ""} /><span>更新</span></button></div></header>
      <main className="ws-main"><div className="ws-page-heading"><div><p className="ws-eyebrow">A PLACE FOR YOUR EVERYDAY TABLE</p><h1>ワークスペース<span>。</span></h1><p className="ws-page-description">ひとりで、みんなで。毎日の食卓に、ちょうどいい場所を。</p></div><button className="ws-button ws-button-primary ws-create-top" data-testid="workspace-create-open" type="button" onClick={() => openDialog({ kind: "create" })} disabled={busy || refreshing || loggingOut}><Icon name="plus" />新しく作成</button></div>
        <div aria-live="polite" className="ws-feedback-area">{error && !dialog && <div className="ws-feedback ws-feedback-error" role="alert"><span>{error}</span><button className="ws-icon-button" type="button" aria-label="エラーを閉じる" onClick={() => setError("")}><Icon name="close" /></button></div>}{notice && <div className="ws-feedback ws-feedback-success"><Icon name="check" /><span>{notice}</span><button className="ws-icon-button" type="button" aria-label="通知を閉じる" onClick={() => setNotice("")}><Icon name="close" /></button></div>}</div>
        {state.invitations.length > 0 && <section className="ws-incoming" aria-label="届いている招待">{state.invitations.map((invitation) => <article className="ws-incoming-item" key={invitation.id}><span className="ws-incoming-icon"><Icon name="mail" /></span><div><h2>「{invitation.workspaceName}」への招待</h2><p>{invitation.inviterName}さんから · {workspaceDate(invitation.expiresAt)}まで有効</p></div><button className="ws-button ws-button-primary ws-button-small" type="button" disabled={busy || refreshing || loggingOut} onClick={() => void mutate(() => workspaceRequest<JoinedWorkspace>(`/api/invitations/${invitation.id}/join`, "POST", {}), "共有ワークスペースに参加しました。", (result) => result.workspaceId)}>参加する<Icon name="arrow" /></button></article>)}</section>}
        <section aria-labelledby="ws-list-heading"><div className="ws-section-heading"><h2 id="ws-list-heading">あなたのワークスペース <span>{state.workspaces.length}</span></h2><p>使いたい場所を選択</p></div><div className="ws-cards">{state.workspaces.map((workspace) => <button type="button" key={workspace.id} className={`ws-card${active?.id === workspace.id ? " is-selected" : ""}`} aria-pressed={active?.id === workspace.id} data-testid="workspace-card" data-workspace-id={workspace.id} onClick={() => selectWorkspace(workspace.id)}><span className="ws-card-top"><span className={`ws-space-icon ${workspace.type === "SHARED" ? "is-shared" : ""}`}><SpaceIcon type={workspace.type} /></span><span className="ws-type-badge">{workspace.type === "SHARED" ? "共有用" : "個人用"}</span></span><strong className="ws-card-name">{workspace.name}</strong><span className="ws-card-description">{workspace.type === "SHARED" ? "大切な人と囲む、いつもの食卓" : "自分のペースで、自分らしく"}</span><span className="ws-card-bottom"><span className="ws-avatars">{workspace.members.slice(0, 3).map((member, index) => <Avatar key={member.userId} name={member.name} small index={index} />)}{workspace.members.length > 3 && <span className="ws-avatar ws-avatar-small ws-avatar-more">+{workspace.members.length - 3}</span>}</span><span>{workspace.members.length}人</span><span className="ws-card-selection">{active?.id === workspace.id ? <><Icon name="check" />選択中</> : <Icon name="arrow" />}</span></span></button>)}<button className="ws-card ws-new-card" type="button" onClick={() => openDialog({ kind: "create" })} disabled={busy || refreshing || loggingOut}><span className="ws-new-card-icon"><Icon name="plus" /></span><strong>新しい場所をつくる</strong><span>暮らしに合わせて、もうひとつ。</span></button></div></section>
        {active && <section className="ws-details" aria-labelledby="ws-settings-heading"><div className="ws-section-heading"><h2 id="ws-settings-heading">ワークスペースの設定</h2><p>選択中の場所を整える</p></div><div className="ws-banner"><div className="ws-banner-content"><span className="ws-banner-icon"><SpaceIcon type={active.type} /></span><div><p className="ws-banner-eyebrow">{active.type === "SHARED" ? "SHARED WORKSPACE" : "PERSONAL WORKSPACE"}</p><h2 data-testid="workspace-selected-name" data-workspace-id={active.id}>{active.name}</h2><p className="ws-banner-description">{active.type === "SHARED" ? "同じ食卓から、毎日を少しずつ。" : "あなただけの、食卓の小さな拠点。"}</p></div></div><button className="ws-button ws-button-banner" data-testid="workspace-rename-open" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "rename", workspace: active })}><Icon name="edit" />名前を変更</button><div className="ws-banner-decoration" aria-hidden="true"><span /><span /><span /></div></div>
          <section className="ws-panel" aria-labelledby="ws-members-heading"><div className="ws-panel-heading"><div><p className="ws-eyebrow">PEOPLE AROUND THE TABLE</p><h3 id="ws-members-heading">メンバー <span className="ws-count-badge" data-testid="workspace-member-count">{active.members.length}</span></h3></div>{active.type === "SHARED" && <button className="ws-button ws-button-secondary ws-button-small" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "invite", workspace: active })}><Icon name="plus" />メンバーを招待</button>}</div><div className="ws-members" data-testid="workspace-member-list">{active.members.map((member, index) => <div className="ws-member" key={member.userId}><Avatar name={member.name} index={index} /><div className="ws-member-info"><strong>{member.name}{member.userId === user.id && <span className="ws-you">あなた</span>}</strong><span>{member.email}</span></div><span className="ws-role">{member.role === "OWNER" ? "オーナー" : "メンバー"}</span></div>)}</div>
            {active.type === "SHARED" && active.members.length === 1 && <div className="ws-invite-empty"><span className="ws-invite-empty-icon"><Icon name="users" /></span><div><strong>一緒に使う相手を、招待しませんか。</strong><p>メールアドレスを指定して、招待リンクを共有できます。</p></div></div>}{active.type === "PERSONAL" && <div className="ws-personal-note"><Icon name="shield" /><p>このワークスペースにアクセスできるのは、あなただけです。<br />一緒に使う場合は、共有用ワークスペースを作成してください。</p></div>}
            {active.pendingInvitations.length > 0 && <div className="ws-pending"><h4>招待中</h4>{active.pendingInvitations.map((invitation) => <div className="ws-pending-item" key={invitation.id}><Icon name="mail" /><span>{invitation.email}<small>{workspaceDate(invitation.expiresAt)}まで有効</small></span><span className="ws-pending-badge">参加待ち</span></div>)}</div>}
          </section><section className="ws-danger-zone"><div><h3>ワークスペースの削除</h3><p>この場所と関連するすべてのデータを削除します。</p></div><button className="ws-button ws-button-danger-outline ws-button-small" data-testid="workspace-delete-open" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "delete", workspace: active })}><Icon name="trash" />削除する</button></section><div className="ws-meta"><span>作成日 {workspaceDate(active.createdAt)}</span><span>{active.type === "SHARED" ? "メンバー全員が設定を変更できます" : "自分だけのワークスペース"}</span></div>
        </section>}
        <footer className="ws-footer"><span>mille.</span><p>日々を味わう、ひとつの場所。</p></footer>
      </main>
    </div>
    {dialog?.kind === "create" && <CreateDialog busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "rename" && <RenameDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "delete" && <DeleteDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "invite" && <InviteDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
  </div>;
}
