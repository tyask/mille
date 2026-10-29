"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="ws-error-page"><section className="auth-card"><span className="card-eyebrow">MILLE</span><h1>読み込みに失敗しました</h1><p className="card-description">接続状況を確認して、もう一度お試しください。</p><button className="login-button test-button" onClick={reset}>再読み込み</button></section></main>;
}
