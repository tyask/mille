# 依存関係の監査と更新

2026-10-29、Vercel install の報告を受け、PR #2 の `74f59c3` の lockfile を
`npm audit --json` と `npm audit --omit=dev --json` で確認した。
どちらも critical 1、high 2（計3パッケージ）だった。これは advisory の総件数ではない。

## 対象と修正版

| パッケージ | 更新前 | 分類 | 監査で確認した修正版の下限 | 採用版 |
| --- | --- | --- | --- | --- |
| Next.js | 16.2.12 | 直接の runtime 依存・critical | 16.4.1 | 16.4.3 |
| sharp | 0.35.3 | Next の optional runtime 依存・high | 0.35.5 | 0.35.5 |
| Zod | 4.4.3 | 直接の runtime 依存・high | 4.6.6 | 4.6.7 |

同じメジャーの修正系列から npm が提示した安定パッチ版を採用した。
sharp の固定 override も更新する。Next だけ更新して古い override を残すと修正を妨げる。
dev 依存の `eslint-config-next` は今回の脆弱性対象ではないが、Next と同じ 16.4.3 に揃える。
Node24.19.0、React19.2.8、Auth.js5 beta.32 は変更しない。Cake のファイルや資源も変更しない。

## 現在のアプリでの影響

- Windows RCE は Windows ファイルシステムが前提で、現在の Linux／Vercel 想定とは異なる。
- AVIF／SVG の画像最適化と sharp の画像デコーダには RCE／メモリ破壊の問題がある。
  Mille に画像アップロードはまだないが、`next/image` を使わないことだけでは
  フレームワークの最適化エンドポイントの到達不能を証明できない。悪用実証は行っていない。
- `next/og` の攻撃者制御 SVG、Cache Components と typed array を返す `use cache`、
  自前の Server Action は現在のソースにない。Auth.js の Route Handler は Server Action とは別である。
- 関連する cache poisoning／metadata image route の利用条件も現在の動的認証画面には見当たらない。
  開発 MCP の情報漏えいは Production ではなく `next dev` の問題であり、Cloud 開発では無関係と扱わない。
- Zod の問題は巨大なコレクション検証でのエラー蓄積によるメモリ枯渇。
  自前コードは文字列の `z.email().safeParse()` のみで配列 schema はないが、
  依存内部を含む全経路の到達不能を証明したとは扱わず更新する。

## 一次資料

- Next SVG RCE: https://github.com/advisories/GHSA-2464-fhr4-w9xw
- Next Server Actions DoS: https://github.com/advisories/GHSA-p3m5-59mp-jv5r
- Next typed array RCE: https://github.com/advisories/GHSA-673q-mjm6-r5xr
- sharp / libheif: https://github.com/advisories/GHSA-rgj7-g3m4-5g8c
- sharp / librsvg: https://github.com/advisories/GHSA-wq5f-xc86-pv6w
- Zod: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- Next 16.4.3: https://github.com/vercel/next.js/releases/tag/v16.4.3

更新後も全依存と runtime の監査を分けて行い、lint・型検査・既存回帰・build を確認する。
CI は `npm run audit:dependencies` で high／critical を失敗にする。
旧 SHA のブラウザ QA 成功を新 SHA の成功へ流用せず、PR 現在 HEAD の CI を確認する。
