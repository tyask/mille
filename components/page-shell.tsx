import type { ReactNode } from "react";
import { Brand } from "./brand";

export function PageShell({ children, signedIn = false }: { children: ReactNode; signedIn?: boolean }) {
  return (
    <div className="page-shell">
      <header className="site-header">
        <Brand compact />
        <span className="header-note">食卓の、その先へ。</span>
      </header>
      <main className={`auth-layout${signedIn ? " auth-layout-signed-in" : ""}`}>
        <section className="welcome-copy" aria-label="Milleへようこそ">
          <p className="eyebrow"><span aria-hidden="true" /> EVERYDAY, A LITTLE BETTER.</p>
          <h2>いつもの食卓に、<br />新しいひと皿を<span className="accent-dot">。</span></h2>
          <p className="welcome-description">おいしく食べること。<br />自分や、大切な人を想うこと。<br />そんな毎日のための、Milleです。</p>
          <div className="table-motif" aria-hidden="true">
            <div className="motif-plate"><div className="motif-leaf motif-leaf-one" /><div className="motif-leaf motif-leaf-two" /><div className="motif-leaf motif-leaf-three" /><div className="motif-stem" /></div>
            <div className="motif-dots"><i /><i /><i /></div>
            <span className="motif-label">a little care, every day</span>
          </div>
        </section>
        {children}
      </main>
      <footer className="site-footer"><span>mille</span><p>日々を味わう、ひとつの場所。</p></footer>
    </div>
  );
}
