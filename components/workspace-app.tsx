"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { signOut } from "next-auth/react";
import dynamic from "next/dynamic";
import type { MealDetail } from "@/lib/shared/meal-types";
import type { SuggestionMode } from "@/lib/shared/suggestion-types";
import type { AppUser } from "@/lib/shared/types";
import type { IssuedInvitation, JoinedWorkspace, Workspace, WorkspaceState, WorkspaceType } from "@/lib/shared/workspaces";
import { Brand } from "./brand";
import { MealApp, type MealNavigationBlock, type MealSelection } from "./meals/meal-app";
import { readMealLocation, writeMealLocation, type WorkspacePane } from "./meals/meal-location";
import { MobileAccessQr } from "./mobile-access-qr";
import { WorkspaceIcon as Icon } from "./workspace-icons";

const SuggestionPanel = dynamic(() => import("./meals/suggestion-panel").then(module => module.SuggestionPanel), {
  loading: () => <p className="meal-feedback" role="status">提案画面を読み込んでいます。</p>,
});

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

function workspaceOptionLabels(workspaces: Workspace[]) {
  const workspacesByName = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    // Native option labels collapse HTML whitespace.
    const name = workspace.name.normalize("NFC").replace(/[ \t\n\f\r]+/g, " ").trim();
    const group = workspacesByName.get(name);
    if (group) group.push(workspace);
    else workspacesByName.set(name, [workspace]);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of workspacesByName) {
    if (group.length === 1) continue;
    for (const type of ["PERSONAL", "SHARED"] as const) {
      const sameType = group.filter(workspace => workspace.type === type);
      // The server orders by last update. Number duplicates by creation order instead.
      sameType.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const typeLabel = type === "PERSONAL" ? "個人用" : "共有用";
      let ordinal = sameType.length === 1 ? 0 : 1;
      for (const workspace of sameType) {
        let label: string;
        do {
          label = `${typeLabel}${ordinal ? ` ${ordinal}` : ""} · ${name}`;
          ordinal += 1;
        } while (workspacesByName.has(label));
        labels.set(workspace.id, label);
      }
    }
  }
  return labels;
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

export default function WorkspaceApp({ user, initialState, initialWorkspaceId, initialLocation, suggestionMode }: {
  user: AppUser;
  initialState: WorkspaceState;
  initialWorkspaceId?: string;
  initialLocation: ReturnType<typeof readMealLocation>;
  suggestionMode: SuggestionMode | null;
}) {
  const suggestionsEnabled = suggestionMode !== null;
  const [state, setState] = useState(initialState);
  const [activeId, setActiveId] = useState(initialState.workspaces.find(workspace => workspace.id === initialWorkspaceId)?.id
    ?? initialState.workspaces[0]?.id ?? "");
  const initialPane = initialLocation.pane === "suggestion" && !suggestionsEnabled ? "meal" : initialLocation.pane;
  const [location, setLocation] = useState({ ...initialLocation, pane: initialPane });
  const [mealRefresh, setMealRefresh] = useState(0);
  const [mealEpoch, setMealEpoch] = useState(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
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
  const mealBlock = useRef<MealNavigationBlock>(null);
  const historyIndex = useRef(0);
  const restoringHistory = useRef(false);
  const active = state.workspaces.find((workspace) => workspace.id === activeId) || state.workspaces[0];
  const optionLabels = workspaceOptionLabels(state.workspaces);
  const storageKey = `mille:workspace:${user.id}`;
  const settings = location.pane === "settings" || !active;
  const suggestions = suggestionsEnabled && location.pane === "suggestion" && !settings;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let stored = initialState.workspaces.find(workspace => workspace.id === initialWorkspaceId)?.id;
      if (!stored) {
        try { stored = localStorage.getItem(storageKey) || undefined; } catch { /* Optional preference storage. */ }
      }
      const preferred = initialState.workspaces.find(workspace => workspace.id === stored) ?? initialState.workspaces[0];
      if (preferred) rememberWorkspace(storageKey, preferred.id);
      const previousIndex = window.history.state?.milleMealIndex;
      historyIndex.current = typeof previousIndex === "number" ? previousIndex : 0;
      writeMealLocation(preferred?.id ?? "", initialLocation.selection, initialPane, historyIndex.current, true);
      setActiveId(preferred?.id ?? "");
      setPreferencesReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialState.workspaces, initialWorkspaceId, initialLocation, initialPane, storageKey]);

  useEffect(() => {
    function onPop(event: PopStateEvent) {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const nextIndex = event.state?.milleMealIndex;
      if (!allowsMealNavigation(mealBlock.current)) {
        if (typeof nextIndex === "number" && nextIndex !== historyIndex.current) {
          restoringHistory.current = true;
          window.history.go(historyIndex.current - nextIndex);
        } else {
          writeMealLocation(active?.id ?? "", location.selection, location.pane, historyIndex.current, true);
        }
        return;
      }
      if (typeof nextIndex === "number") historyIndex.current = nextIndex;
      const params = new URL(window.location.href).searchParams;
      const next = readMealLocation(key => params.get(key));
      const available = suggestionsEnabled || next.pane !== "suggestion";
      if (!available) next.pane = "meal";
      const requested = state.workspaces.find(workspace => workspace.id === params.get("workspace"));
      if (requested) {
        selectionSequence.current += 1;
        setActiveId(requested.id);
        rememberWorkspace(storageKey, requested.id);
      }
      if (!requested || !available) writeMealLocation(requested?.id ?? active?.id ?? "", next.selection, next.pane, historyIndex.current, true);
      setMealEpoch(previous => previous + 1);
      mealBlock.current = null;
      setLocation(next);
      setMobileOpen(false);
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (mealBlock.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active?.id, location, state.workspaces, storageKey, suggestionsEnabled]);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 700px), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse)");
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

  function selectWorkspace(id: string) {
    if (active?.id === id) { setMobileOpen(false); return; }
    if (!allowsMealNavigation(mealBlock.current)) return;
    mealBlock.current = null;
    selectionSequence.current += 1;
    setActiveId(id);
    setMobileOpen(false);
    rememberWorkspace(storageKey, id);
    updateWorkspaceLocation(id, ++historyIndex.current);
  }
  function selectMeal(selection: MealSelection) {
    if (selection.date === location.selection.date && selection.view === location.selection.view && selection.meal === location.selection.meal) return;
    setLocation({ ...location, selection });
    writeMealLocation(active?.id ?? "", selection, location.pane, ++historyIndex.current);
  }
  function selectPane(pane: WorkspacePane) {
    if (pane === location.pane) { setMobileOpen(false); return; }
    if (!allowsMealNavigation(mealBlock.current)) return;
    mealBlock.current = null;
    setNotice("");
    setMobileOpen(false);
    setLocation({ ...location, pane });
    writeMealLocation(active?.id ?? "", location.selection, pane, ++historyIndex.current);
  }
  function showAdoptedMeal(meal: MealDetail) {
    const selection = { ...location.selection, date: meal.mealDate, meal: meal.mealType };
    mealBlock.current = null;
    setLocation({ selection, pane: "meal" });
    writeMealLocation(meal.workspaceId, selection, "meal", ++historyIndex.current);
    setNotice("献立を予定として保存しました。");
  }
  function openDialog(next: DialogState) { if (refreshing || loggingOut || mealBlock.current === "saving") return; setError(""); setNotice(""); setDialog(next); setMobileOpen(false); }
  function closeDialog() { if (!mutationPending.current) { setDialog(null); } }
  async function reload(preferredId?: string, selectedAtStart = selectionSequence.current) {
    const sequence = ++requestSequence.current;
    const next = await workspaceRequest<WorkspaceState>("/api/workspaces");
    if (sequence !== requestSequence.current) return;
    setState(next);
    if (selectedAtStart !== selectionSequence.current) return;
    if (preferredId && next.workspaces.some(workspace => workspace.id === preferredId)) {
      selectWorkspace(preferredId);
    } else if (!next.workspaces.some(workspace => workspace.id === active?.id)) {
      const fallback = next.workspaces[0]?.id ?? "";
      mealBlock.current = null;
      setActiveId(fallback);
      if (fallback) rememberWorkspace(storageKey, fallback);
      updateWorkspaceLocation(fallback, historyIndex.current, true);
    }
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
  async function refresh() { if (refreshing || mutationPending.current || loggingOut) return; setMealRefresh(value => value + 1); setRefreshing(true); setError(""); setNotice(""); try { await reload(); setNotice("最新の情報に更新しました。"); } catch { setError("最新情報を取得できませんでした。時間をおいて再度お試しください。"); } finally { setRefreshing(false); } }
  async function logout() {
    if (loggingOut || mutationPending.current || !allowsMealNavigation(mealBlock.current)) return;
    setLoggingOut(true); setError("");
    try { await signOut({ redirect: false }); mealBlock.current = null; try { localStorage.setItem("mille:auth-change", String(Date.now())); } catch { /* Optional browser storage. */ } window.location.replace("/"); }
    catch { setError("ログアウトできませんでした。もう一度お試しください。"); setLoggingOut(false); }
  }

  return <div className="workspace-app" data-testid="authenticated-home">
    {mobileOpen && <button className="ws-sidebar-backdrop" type="button" tabIndex={-1} aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)} />}
    <aside className={`ws-sidebar${mobileOpen ? " is-open" : ""}`} aria-label="ワークスペースメニュー" id="ws-sidebar">
      <Brand compact />
      <button id="ws-mobile-close" className="ws-icon-button ws-mobile-close" type="button" aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)}>
        <Icon name="close" />
      </button>
      <div className="ws-picker">
        <label htmlFor="ws-workspace-select">ワークスペース</label>
        <select
          id="ws-workspace-select"
          data-testid="workspace-select"
          value={active?.id ?? ""}
          onChange={event => selectWorkspace(event.target.value)}
          disabled={!preferencesReady || !active}
          title={active && (optionLabels.get(active.id) ?? active.name)}
        >
          {!active && <option value="">ワークスペースなし</option>}
          {state.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{optionLabels.get(workspace.id) ?? workspace.name}</option>)}
        </select>
        <button className="ws-sidebar-create" data-testid="workspace-create-open" type="button" onClick={() => openDialog({ kind: "create" })} disabled={busy || refreshing || loggingOut}>
          <Icon name="plus" />ワークスペースを作成
        </button>
      </div>
      <nav className="ws-nav" aria-label="ワークスペース内の画面">
        <button type="button" aria-current={settings || suggestions ? undefined : "page"} disabled={!active} onClick={() => selectPane("meal")}>
          <Icon name="calendar" />献立
        </button>
        {suggestionsEnabled && <button data-testid="suggestion-open" type="button" aria-current={suggestions ? "page" : undefined} disabled={!active} onClick={() => selectPane("suggestion")}>
          <Icon name="sparkles" />提案
        </button>}
        <button type="button" aria-current={settings ? "page" : undefined} onClick={() => selectPane("settings")}>
          <Icon name="settings" />ワークスペース設定
        </button>
      </nav>
      <div className="ws-sidebar-bottom">
        <MobileAccessQr />
        <div className="ws-account">
          <Avatar name={user.name} small />
          <div><strong>{user.name}</strong><span data-testid="authenticated-user-email" title={user.email}>{user.email}</span></div>
        </div>
        <button className="ws-logout" type="button" onClick={() => void logout()} disabled={busy || refreshing || loggingOut} aria-label="ログアウト">
          <Icon name="logout" />{loggingOut ? "ログアウト中…" : "ログアウト"}
        </button>
      </div>
    </aside>
    <div className="ws-main-shell" inert={mobileOpen}><header className="ws-topbar"><button className="ws-mobile-menu" type="button" aria-label="ワークスペースメニューを開く" aria-expanded={mobileOpen} aria-controls="ws-sidebar" onClick={() => setMobileOpen(!mobileOpen)}><Icon name="menu" /><span>mille.</span></button><div className="ws-breadcrumb"><span>mille</span><span aria-hidden="true">/</span><span>ワークスペース</span></div><div className="ws-topbar-right"><span className="ws-private-label"><Icon name="shield" />自分たちだけのスペース</span><button className="ws-refresh" data-testid="workspace-refresh" type="button" aria-label="最新情報に更新" onClick={() => void refresh()} disabled={busy || refreshing || loggingOut}><Icon name="refresh" className={refreshing ? "ws-spin" : ""} /><span>更新</span></button></div></header>
      <main className={`ws-main${settings ? "" : " meal-workspace-main"}`}>
        <div className="meal-workspace-header">
          {settings ? <h1 id="ws-settings-heading">ワークスペース設定</h1> : <h1 data-testid="workspace-selected-name" data-workspace-id={active?.id}>{active?.name}</h1>}
        </div>
        <div aria-live="polite" className="ws-feedback-area">{error && !dialog && <div className="ws-feedback ws-feedback-error" role="alert"><span>{error}</span><button className="ws-icon-button" type="button" aria-label="エラーを閉じる" onClick={() => setError("")}><Icon name="close" /></button></div>}{notice && <div className="ws-feedback ws-feedback-success"><Icon name="check" /><span>{notice}</span><button className="ws-icon-button" type="button" aria-label="通知を閉じる" onClick={() => setNotice("")}><Icon name="close" /></button></div>}</div>
        {state.invitations.length > 0 && <section className="ws-incoming" aria-label="届いている招待">{state.invitations.map((invitation) => <article className="ws-incoming-item" key={invitation.id}><span className="ws-incoming-icon"><Icon name="mail" /></span><div><h2>「{invitation.workspaceName}」への招待</h2><p>{invitation.inviterName}さんから · {workspaceDate(invitation.expiresAt)}まで有効</p></div><button className="ws-button ws-button-primary ws-button-small" type="button" disabled={busy || refreshing || loggingOut} onClick={() => void mutate(() => workspaceRequest<JoinedWorkspace>(`/api/invitations/${invitation.id}/join`, "POST", {}), "共有ワークスペースに参加しました。", (result) => result.workspaceId)}>参加する<Icon name="arrow" /></button></article>)}</section>}
        {settings ? (active && <section className="ws-details" aria-labelledby="ws-settings-heading">
          <div className="ws-banner">
            <div className="ws-banner-content">
              <span className="ws-banner-icon"><SpaceIcon type={active.type} /></span>
              <div>
                <p className="ws-banner-eyebrow">{active.type === "SHARED" ? "共有用" : "個人用"}</p>
                <h2 data-testid="workspace-selected-name" data-workspace-id={active.id}>{active.name}</h2>
              </div>
            </div>
            <button className="ws-button ws-button-banner" data-testid="workspace-rename-open" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "rename", workspace: active })}>
              <Icon name="edit" />名前を変更
            </button>
            <div className="ws-banner-decoration" aria-hidden="true"><span /><span /><span /></div>
          </div>
          <section className="ws-panel" aria-labelledby="ws-members-heading"><div className="ws-panel-heading"><div><p className="ws-eyebrow">PEOPLE AROUND THE TABLE</p><h3 id="ws-members-heading">メンバー <span className="ws-count-badge" data-testid="workspace-member-count">{active.members.length}</span></h3></div>{active.type === "SHARED" && <button className="ws-button ws-button-secondary ws-button-small" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "invite", workspace: active })}><Icon name="plus" />メンバーを招待</button>}</div><div className="ws-members" data-testid="workspace-member-list">{active.members.map((member, index) => <div className="ws-member" key={member.userId}><Avatar name={member.name} index={index} /><div className="ws-member-info"><strong>{member.name}{member.userId === user.id && <span className="ws-you">あなた</span>}</strong><span>{member.email}</span></div><span className="ws-role">{member.role === "OWNER" ? "オーナー" : "メンバー"}</span></div>)}</div>
            {active.type === "SHARED" && active.members.length === 1 && <div className="ws-invite-empty"><span className="ws-invite-empty-icon"><Icon name="users" /></span><div><strong>一緒に使う相手を、招待しませんか。</strong><p>メールアドレスを指定して、招待リンクを共有できます。</p></div></div>}{active.type === "PERSONAL" && <div className="ws-personal-note"><Icon name="shield" /><p>このワークスペースにアクセスできるのは、あなただけです。<br />一緒に使う場合は、共有用ワークスペースを作成してください。</p></div>}
            {active.pendingInvitations.length > 0 && <div className="ws-pending"><h4>招待中</h4>{active.pendingInvitations.map((invitation) => <div className="ws-pending-item" key={invitation.id}><Icon name="mail" /><span>{invitation.email}<small>{workspaceDate(invitation.expiresAt)}まで有効</small></span><span className="ws-pending-badge">参加待ち</span></div>)}</div>}
          </section><section className="ws-danger-zone"><div><h3>ワークスペースの削除</h3><p>この場所と関連するすべてのデータを削除します。</p></div><button className="ws-button ws-button-danger-outline ws-button-small" data-testid="workspace-delete-open" type="button" disabled={busy || refreshing || loggingOut} onClick={() => openDialog({ kind: "delete", workspace: active })}><Icon name="trash" />削除する</button></section><div className="ws-meta"><span>作成日 {workspaceDate(active.createdAt)}</span><span>{active.type === "SHARED" ? "メンバー全員が設定を変更できます" : "自分だけのワークスペース"}</span></div>
        </section>) : active && preferencesReady && (suggestions
          ? <SuggestionPanel key={`${active.id}:${mealEpoch}`} workspaceId={active.id} selection={location.selection}
            mode={suggestionMode}
            onAdopt={showAdoptedMeal} onBlockChange={block => { mealBlock.current = block; }} />
          : <MealApp key={`${active.id}:${mealEpoch}`} workspaceId={active.id} selection={location.selection}
            refresh={mealRefresh} onSelection={selectMeal} onBlockChange={block => { mealBlock.current = block; }}
            onSuggest={suggestionsEnabled ? () => selectPane("suggestion") : undefined} />)}
      </main>
    </div>
    {dialog?.kind === "create" && <CreateDialog busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "rename" && <RenameDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "delete" && <DeleteDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
    {dialog?.kind === "invite" && <InviteDialog workspace={dialog.workspace} busy={busy} error={error} onClose={closeDialog} mutate={mutate} />}
  </div>;
}

function rememberWorkspace(key: string, id: string) {
  try { localStorage.setItem(key, id); } catch { /* Optional browser preference. */ }
}

function updateWorkspaceLocation(id: string, index: number, replace = false) {
  const params = new URL(window.location.href).searchParams;
  const { selection, pane } = readMealLocation(key => params.get(key));
  writeMealLocation(id, selection, pane, index, replace);
}

function allowsMealNavigation(block: MealNavigationBlock) {
  return block === "draft" ? window.confirm("保存していない入力を破棄しますか？") : block !== "saving";
}
