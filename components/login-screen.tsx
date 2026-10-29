"use client";

import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";
import { PageShell } from "./page-shell";

type AuthMode = "google" | "test" | "disabled";

export function LoginScreen({ mode, error }: { mode: AuthMode; error?: string }) {
  const [pending, setPending] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const message = loginError ?? (error ? "ログインできませんでした。利用できるアカウントを確認し、もう一度お試しください。" : null);

  useEffect(() => {
    function resetAfterHistoryRestore(event: PageTransitionEvent) {
      if (!event.persisted) return;
      setPending(null);
      setLoginError(null);
    }
    window.addEventListener("pageshow", resetAfterHistoryRestore);
    return () => window.removeEventListener("pageshow", resetAfterHistoryRestore);
  }, []);

  async function login(testUserKey?: "user-a" | "user-b") {
    if (pending) return;
    setPending(testUserKey ?? "google");
    setLoginError(null);
    try {
      if (testUserKey) {
        await signIn("test-login", { testUserKey, redirectTo: "/" });
      } else {
        await signIn("google", { redirectTo: "/" });
      }
    } catch {
      setLoginError("ログインできませんでした。時間をおいて、もう一度お試しください。");
      setPending(null);
    }
  }

  return (
    <PageShell>
      <section className="auth-card" aria-labelledby="login-title">
        <span className="card-eyebrow">WELCOME TO MILLE</span>
        <h1 id="login-title">Milleへようこそ</h1>
        <p className="card-description">あなたのアカウントで、<br className="mobile-only" />ここからはじめましょう。</p>
        {mode === "test" && <span className="preview-badge"><span aria-hidden="true" /> テスト環境</span>}
        {message && <p className="form-message form-error" role="alert">{message}</p>}
        <div className="login-actions" aria-busy={pending !== null}>
          {mode === "google" && <button className="login-button google-button" onClick={() => void login()} disabled={pending !== null}>
            <svg className="google-symbol" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.4a4.6 4.6 0 0 1-2 3v2.7h3.3c1.9-1.8 2.9-4.3 2.9-7.7Z" /><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.7c-.9.6-2 1-3.4 1a6 6 0 0 1-5.7-4.2H3v2.7A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.3 13.7a6 6 0 0 1 0-3.4V7.6H3a10 10 0 0 0 0 8.8l3.3-2.7Z" /><path fill="#EA4335" d="M12 6.1c1.5 0 2.8.5 3.8 1.5L18.7 5A9.7 9.7 0 0 0 12 2a10 10 0 0 0-9 5.6l3.3 2.7A6 6 0 0 1 12 6.1Z" /></svg>
            {pending === "google" ? "ログイン画面へ移動中…" : "Googleでログイン"}
            <span className="button-arrow" aria-hidden="true">↗</span>
          </button>}
          {mode === "test" && <>
            <button className="login-button test-button" onClick={() => void login("user-a")} disabled={pending !== null}><span className="test-avatar" aria-hidden="true">A</span>{pending === "user-a" ? "ログイン中…" : "テストユーザーAでログイン"}<span className="button-arrow" aria-hidden="true">→</span></button>
            <button className="login-button test-button secondary" onClick={() => void login("user-b")} disabled={pending !== null}><span className="test-avatar" aria-hidden="true">B</span>{pending === "user-b" ? "ログイン中…" : "テストユーザーBでログイン"}<span className="button-arrow" aria-hidden="true">→</span></button>
          </>}
          {mode === "disabled" && <p className="form-message" role="status">ただいまログインをご利用いただけません。時間をおいて、もう一度お試しください。</p>}
        </div>
        <div className="card-divider" />
        <p className="login-note">{mode === "test" ? "この環境では、確認用のテストアカウントだけを利用できます。" : "あらかじめ登録されたアカウントでご利用いただけます。"}</p>
        <p className="private-note"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" /><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeLinecap="round" /></svg>安心して、自分らしく。</p>
      </section>
    </PageShell>
  );
}
