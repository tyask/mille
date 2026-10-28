"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";
import type { AppUser } from "@/lib/shared/types";
import { PageShell } from "./page-shell";
import { SessionBoundary } from "./session-boundary";

export function AuthenticatedHome({ user }: { user: AppUser }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await signOut({ redirect: false });
      try { localStorage.setItem("mille:auth-change", String(Date.now())); } catch { /* Browser storage is optional. */ }
      window.location.replace("/");
    } catch {
      setError("ログアウトできませんでした。もう一度お試しください。");
      setPending(false);
    }
  }

  return (
    <PageShell signedIn>
      <SessionBoundary userId={user.id}>
        <section className="auth-card home-card" aria-labelledby="home-title" data-testid="authenticated-home">
          <span className="signed-in-badge"><span aria-hidden="true">✓</span> ログイン済み</span>
          <h1 id="home-title">ログインできました</h1>
          <p className="card-description">Milleへようこそ。<br />今日も、あなたらしい一日を。</p>
          <div className="user-card">
            <span className="user-avatar" aria-hidden="true">{Array.from(user.name.trim())[0] ?? "M"}</span>
            <div className="user-details"><p className="user-name">{user.name}</p><p className="user-email" data-testid="authenticated-user-email">{user.email}</p></div>
          </div>
          {error && <p className="form-message form-error" role="alert">{error}</p>}
          <button className="logout-button" disabled={pending} onClick={() => void logout()}>{pending ? "ログアウト中…" : "ログアウト"}<span aria-hidden="true">↗</span></button>
        </section>
      </SessionBoundary>
    </PageShell>
  );
}
