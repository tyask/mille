# 開発・検証・環境設定

## 開発

計画提示・承認 → 保存済み Issue 本文・URL の提示・別承認 → ブランチ・Intent → 実装・自己レビュー
→ 記録を凍結して commit → 別 Agent レビュー → 最終 SHA の検証 → draft PR → CI・正式 Preview → Ready。
merge と Production 操作は別判断。詳細は [AGENTS.md](../AGENTS.md)。Cloud は既存 checkout を使う。

Node は `.node-version`、依存は `npm ci`。`setup:cloud` は依存と公式 Playwright Chromium を準備する。
配布先 `registry.npmjs.org`、`cdn.playwright.dev`、`storage.googleapis.com` が必要。
拒否はサポートされるネットワーク設定で解消し、CA・proxy・download 経路を変更しない。
書込可能なキャッシュにはプロセスだけ `npm_config_cache=/workspace/.npm-cache`、
`PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright` を指定できる。

`dev:cloud` はプロバイダーの資格情報を子プロセスへ引き継がず、ループバック PGlite と架空 A/B を使う。
`.env` 系ファイルがある場合は起動を拒否する。既存ファイルを勝手に削除・移動しない。
停止すると自分で起動した DB・アプリを終了する。

## 正式環境

資源操作前に承認された account/team、project、DB、料金を照合し、重複作成しない。
Mille 専用 Production／Preview を分離し、Cake や本番の実データを Preview にコピーしない。
追加費用・永続資格情報・OAuth 設定変更・権限拡大は別途承認を得る。

| 環境 | 設定 |
| --- | --- |
| Production | `AUTH_MODE=google`、専用 `AUTH_SECRET`、`AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET`、`DATABASE_URL`、`MILLE_PRODUCTION_DATABASE_HOST`、`MILLE_PRODUCTION_ENVIRONMENT_ID=mille-production` |
| Preview | `AUTH_MODE=test`、別の `AUTH_SECRET`、`MILLE_PREVIEW_DATABASE_URL`、`MILLE_PREVIEW_DATABASE_HOST`、`MILLE_PREVIEW_ENVIRONMENT_ID=mille-preview` |

HOST は接続 URL の正確な hostname。DB marker の project・環境・環境 ID を検証する。
Preview 設定が欠落・不一致なら拒否し、`DATABASE_URL` で補完しない。
Production は `AUTH_MODE=test` でもテスト認証を無効にする。
`AUTH_URL` を指定する場合はその環境の正規 origin を使う。管理用 provider token を build/runtime に渡さない。

## DB と利用者

接続先照合後、専用初期化 SQL と migration を適用する。空でない別用途 DB は拒否する。
marker と migration 原文 hash を照合し、適用済 SQL は編集しない。
Preview seed は重複登録や停止状態の解除をせず、Production では拒否する。
正確なコマンドと SQL は [DB手順](../scripts/db/README.md) を参照する。
実利用者は本人指定後に登録する。Cake の固定初期管理者メールは使わない。
保護処理は内部 ID・正規化メール・現在の有効状態を再確認し、応答を共有キャッシュしない。
ブラウザのログアウトと既発行 JWT 全体の失効を区別し、利用停止は DB 再確認で拒否する。

## 最終検証・初回 Preview

最終 SHA と clean 状態を前後で照合し、check:node、lint、typecheck、test、build、qa:cloud を行う。
依存更新時は `npm run audit:dependencies` も確認する。CI は全依存の high／critical を検出すると失敗する。[監査記録](dependency-security.md)も参照する。
PC/mobile × A/B でログイン・再読込・本人表示・ログアウト・未認証拒否を確認する。
無効化後の拒否・メール検証・mode・redirect・Production のテスト認証禁止を回帰テストする。
初回 PR は main に未導入の管理 Workflow に依存せず、承認済み正規 CLI／API で専用 Preview を用意する。
DB 初期化は対象照合後の専用工程にし、build が勝手に migration/seed しない。
CI は provider 資格情報を持たず、PR コードを管理資格情報付きで動かさない。
固有 origin、Deployment、DB marker、`/api/runtime` の SHA を前後で照合する。
Git非接続の初回デプロイでは、照合済みソースの完全 SHA を build 変数 `MILLE_SOURCE_SHA` に設定する。
VercelのGit SHAも存在する場合は一致を必須にする。両方なければcheckoutのHEADを使用する。
Deployment Protection を維持し、既存 bypass を使用する場合も対象 origin のみに送る。
Google は専用 client と本人承認アカウントで別途確認する。callback は対象 origin の `/api/auth/callback/google`。
基本プロフィールとメール以外の scope を追加しない。A/B 成功を実 Google の成功と扱わない。
検証不足は draft を維持し、未実施理由と必要な対応を報告する。公開・本番反映・復元は実施証拠がある場合だけ完了とする。
