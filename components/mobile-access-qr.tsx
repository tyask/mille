"use client";

import { QRCodeSVG } from "qrcode.react";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getLoginUrl = () => `${window.location.origin}/`;
const getServerLoginUrl = () => "";

export function MobileAccessQr() {
  const loginUrl = useSyncExternalStore(subscribe, getLoginUrl, getServerLoginUrl);
  if (!loginUrl) return null;

  return (
    <section className="mobile-access-qr" aria-label="スマホでログイン" data-testid="mobile-access-qr">
      <p className="mobile-access-qr-title">スマホでログイン</p>
      <a
        className="mobile-access-qr-link"
        href={loginUrl}
        aria-label="milleのログインページを開く"
        data-testid="mobile-access-qr-link"
      >
        <QRCodeSVG value={loginUrl} size={136} level="M" marginSize={4} aria-hidden="true" data-testid="mobile-access-qr-code" />
      </a>
      <p className="mobile-access-qr-instructions">カメラで読み取ってください。</p>
    </section>
  );
}
