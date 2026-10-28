"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function SessionBoundary({ userId, children }: { userId: string; children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [attempt, setAttempt] = useState(0);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let request = 0;
    let controller: AbortController | undefined;

    async function verify() {
      const currentRequest = ++request;
      controller?.abort();
      controller = new AbortController();
      if (content.current) content.current.style.visibility = "hidden";
      setState("checking");
      try {
        const response = await fetch("/api/me", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!alive || currentRequest !== request) return;
        if (response.status === 401) {
          window.location.replace("/");
          return;
        }
        if (!response.ok) throw new Error("Session unavailable");
        const body = await response.json() as { user?: { id?: string } };
        if (!alive || currentRequest !== request) return;
        if (body.user?.id !== userId) {
          window.location.replace("/");
          return;
        }
        if (content.current) content.current.style.visibility = "visible";
        setState("ready");
      } catch {
        if (alive && currentRequest === request) setState("unavailable");
      }
    }

    function hideBeforeHistorySnapshot() {
      if (content.current) content.current.style.visibility = "hidden";
    }
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) void verify();
    }
    function onVisible() {
      if (document.visibilityState === "visible") void verify();
    }
    function onStorage(event: StorageEvent) {
      if (event.key === "mille:auth-change") void verify();
    }

    void verify();
    window.addEventListener("pagehide", hideBeforeHistorySnapshot);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", verify);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      request += 1;
      controller?.abort();
      window.removeEventListener("pagehide", hideBeforeHistorySnapshot);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", verify);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, attempt]);

  return (
    <div className="session-boundary">
      <div ref={content} className="session-content" hidden={state !== "ready"}>{children}</div>
      {state !== "ready" && <section className="auth-card session-status" aria-live="polite" aria-busy={state === "checking"}>
        {state === "checking" ? <><span className="loading-ring" aria-hidden="true" /><p>ログイン状態を確認しています。</p></> : <><h1>接続を確認してください</h1><p>ログイン状態を確認できませんでした。</p><button className="login-button test-button" onClick={() => setAttempt((value) => value + 1)}>もう一度確認する</button></>}
      </section>}
    </div>
  );
}
