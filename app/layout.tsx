import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./workspaces.css";
import "./mobile-access-qr.css";
import "./meals.css";

export const metadata: Metadata = {
  title: "Mille — 食卓の、その先へ。",
  description: "いつもの食卓に、新しいひと皿を。Milleへようこそ。",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FBF6EA",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
