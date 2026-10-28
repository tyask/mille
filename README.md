# mille

毎日の献立を考えるアプリの最初の基盤です。現在は Google ログイン、ログアウト、認証済みホームのみを対象とします。
ワークスペース、写真解析、栄養計算、献立提案は未実装です。将来は献立提案を最優先に開発します。

Node.js **24.19.0** / Next.js **16.2.12** / React **19.2.8** / TypeScript **6.0.3** /
Auth.js **5.0.0-beta.32** / Neon PostgreSQL / Vercel。

## ローカルで試す

外部 DB・Google・Vercel の秘密値は不要です。Node を `.node-version` に合わせて実行します。

```bash
npm ci
npm run setup:cloud
npm run dev:cloud
```

専用 PGlite と架空 A/B で通常の Auth.js セッションを発行します。停止すると DB は破棄されます。
実 Google OAuth／Neon／Vercel の検証とは異なります。runner 用 checkout に `.env` 等を置かないでください。

## 検証

```bash
npm run check:node
npm run lint
npm run typecheck
npm test
npm run build
npm run qa:cloud
```

PC/mobile × A/B のログイン、再読込、本人表示、ログアウト、未認証拒否を検証し、結果を `.mille/cloud/` に保存します。

## 正式環境

Google は確認済みメールかつ事前登録済み・有効な利用者だけを許可し、自動登録しません。
Production と Preview は専用 DB・署名鍵を使います。設定名は [.env.example](.env.example)、
初期化と運用は [開発手順](docs/development.md)、[DB手順](scripts/db/README.md) を参照してください。

依頼は [Issue #1](https://github.com/tyask/mille/issues/1)。Cake の技術構成・認証・二段階承認を踏襲します。
Cake の家計機能・本番設定・固定利用者は流用しません。
