# 開発・検証・環境設定

## 開発

計画提示・承認 → 保存済み Issue 本文・URL の提示・別承認 → ブランチ・Intent → 実装・自己レビュー
→ 記録を凍結して commit → 別 Agent レビュー → 最終 SHA の検証 → draft PR → CI・正式 Preview → Ready。
merge と Production 操作は別判断。詳細は [AGENTS.md](../AGENTS.md)。Cloud は既存 checkout を使う。

## Cloud タスクの開始

[Issue #5](https://github.com/tyask/mille/issues/5) の開始手順を使う。
Cloud の公式仕様には[バックグラウンドでの repository refresh](https://learn.chatgpt.com/docs/environments/cloud-environments#reuse-and-update-saved-state)がある。
これは既存タスクの作業状態を保持することや、作業開始時点で最新 main と同期済みであることの保証とは区別する。
各タスクで既存 checkout を使い、重複 worktree を作らない。

`/workspace/mille` で `AGENTS.md` を読み、`git status --short`、`git branch --show-current`、
`git rev-parse HEAD` を確認する。Node を `.node-version` に合わせ、開始の意図に応じて次を選ぶ。

| 意図 | コマンド | 条件と動作 |
| --- | --- | --- |
| 承認済みの新規作業 | `npm run task:start -- new codex/<name>` | 計画・保存済み Issue の両承認後。clean で現在 HEAD が fetch 済み `origin/main` の祖先の場合だけ、その最新 SHA から新しいブランチを作る。local main は動かさない。 |
| 継続作業・調査 | `npm run task:start -- continue <expectedbranch>` | 現在ブランチが期待値と一致することを必須にし、fetch 後に状態を報告する。checkout や作業ファイルを同期しない。 |

`<name>` と `<expectedbranch>` は実際の承認済み作業名・期待ブランチ名に置き換える。
両承認前は `continue` の調査・状態報告までにする。新規か継続か、または期待ブランチが不明なら現在ブランチを確認用に使って
`continue` で確認・報告し、編集やブランチ作成を止める。この確認を継続作業への承認とは扱わない。
現在ブランチを特定できない場合や detached HEAD の場合は状態を報告して止める。
新規開始元は main に限らず、main に取り込まれた旧 feature branch でも祖先条件を満たせばよい。
切替先の追跡ファイルと ignored ファイルが衝突する場合は、上書きせず拒否する。

結果 JSON で fetch の成否、HEAD、基準となる `origin/main` の完全 SHA、差分、依存状態を確認する。
`new` はブランチ作成結果も報告する。dirty、未公開コミット、main や自身の remote branch との
遅れ・先行・分岐があれば、その内容と必要な判断を報告する。SHA が異なるだけで内容が古いとは断定しない。
fetch 失敗時は古い remote-tracking ref を最新確認済みと扱わず、原因と阻害要因を報告する。
`continue` の Git 変更は fetch のみで、pull / reset / stash / rebase は自動実行しない。
旧ブランチ、未コミット変更、ignored ファイルを削除しない。
最新 main を含み、自身の remote branch と一致する公開済み feature branch は、main より先行していても通常の継続として扱う。
main への遅れ、自身の remote との差、dirty、未公開コミット、依存状態が unknown / stale の場合は要対応になる。

| 終了コード | 意味 |
| --- | --- |
| `0` | CLI の確認条件成立。実装の両承認やアプリ動作検証を代替しない。 |
| `2` | 要対応で ready ではない。JSON の状態と、既に行われたブランチ作成の有無を確認する。 |
| `1` | 失敗・拒否。原因を確認し、同じ条件のまま繰り返さない。 |

## 依存とブラウザの準備

依存の状態は `node_modules/.mille-dependencies.json` の導入記録を照合する。
記録がない `unknown` や依存定義・lockfile・Node 等との不一致を示す
`stale` は、`node_modules` が存在していても導入済みと扱わない。両承認後、次を実行する。

```bash
cd /workspace/mille
npm run deps:sync
npm run task:start -- continue codex/task-name
```

最後のブランチ名は現在の承認済みブランチに置き換える。`deps:sync` は `npm ci` で依存を再導入し、
成功した内容を記録する。Chromium は取得しない。再確認で他の要対応事項が残る場合は解消済みと扱わない。
`new` がブランチ作成後に依存不足を報告した場合も、そのブランチを保持してこの手順に進む。
同名の `new` を繰り返したり、ブランチを削除してやり直したりしない。

`npm run setup:cloud` は依存と公式 Playwright Chromium を準備する。Git の fetch・ブランチ作成・同期は行わない。
Git 確認は `task:start`、ブラウザが不要な依存再導入は `deps:sync` に分ける。
配布先 `registry.npmjs.org`、`cdn.playwright.dev`、`storage.googleapis.com` が必要。
拒否はサポートされるネットワーク設定で解消し、CA・proxy・download 経路を変更しない。
書込可能なキャッシュにはプロセスだけ `npm_config_cache=/workspace/.npm-cache`、
`PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright` を指定できる。

`dev:cloud` はプロバイダーの資格情報を子プロセスへ引き継がず、ループバック PGlite と架空 A/B を使う。
`.env` 系ファイルがある場合は起動を拒否する。既存ファイルを勝手に削除・移動しない。
停止すると自分で起動した DB・アプリを終了する。
起動したプロセスは公開 snapshot からの復元後も動いているとは仮定しない。
必要なタスクで `npm run dev:cloud` を起動し、HTTP 200 のログイン画面に架空 A/B の選択肢があり、
未認証の `/api/me` が HTTP 401 を返すことを確認する。ブラウザでの機能確認は `npm run qa:cloud` を使う。

Cloud の `start_skill` へ統合する本文と反映手順は [Cloud 起動指示](cloud-start-skill.md) を参照する。
この変更では公開環境へ起動指示を反映していない。最新の公開設定を確認できず、取得できる旧ドラフトだけで
最新設定を置き換えない。設定の保存・公開、既存タスクへの反映、新規タスクでの復元検証は別々の証拠で報告する。
既存タスクが最新公開版へ自動移行したとは主張しない。Issue #3 / PR #4 のワークスペース機能は本件の対象外。

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
ワークスペースは個人用分離、作成・選択復元、招待・参加、所属者による名称変更・削除も確認する。
共有の3人以上の参加は単体テスト用PGliteの架空fixtureで検証し、正式利用者やA/Bログイン対象は変更しない。
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
