import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className={`brand${compact ? " brand-compact" : ""}`} href="/" prefetch={false} aria-label="Mille ホーム">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="M9 23V12.5c0-2.9 5.6-3.6 7 0 1.4-3.6 7-2.9 7 0V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M16 13v10M18 7c1.8-2.9 4.2-2.6 5.8-2.3-.5 1.8-2.7 3.7-5.8 2.3Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="brand-word">mille<span className="brand-dot">.</span></span>
    </Link>
  );
}
