# PR 専用 Preview

同一リポジトリの `codex/*` から `main` に向けた PR が対象です。draft も含みます。PR の作成・更新・再オープン・クローズを `Mille PR Events` が受け付けます。merge 時は `main` の push も照合します。受付ではコードの checkout や外部サービスの操作を行いません。

`Mille PR Preview` は `main` 上のコードで、通知元、PR の所属、対象ブランチ、HEAD、状態を GitHub API で照合します。管理ジョブは PR ごとに直列化し、操作直前にも状態を確認します。PR のソースは照合済みの SHA から Git オブジェクトとして取り出し、ビルドは Vercel 上で行います。PR のコードを管理ジョブで実行することはありません。

Neon の PR 専用ブランチで、承認済みの適用済み SQL と原文が一致することを確かめ、現在の PR HEAD の migration と架空 A/B を適用します。同じ PR を更新しても DB を維持します。PR の終了時は所有を照合した Vercel デプロイと Neon ブランチを順に削除します。再実行は同じ PR の既存リソースを照合します。失敗時は管理ジョブの停止工程、PR 番号、SHA を確認し、所有を確認できないリソースは運用担当者が調査します。

## 有効化

1. PR 専用の Vercel と Neon のプロジェクト `mille-pr-preview` を確認します。新設が必要であれば、契約上の枠と追加費用の有無を調べます。既存の本番・常設 Preview の設定や Cake のリソースは使用しません。
2. Vercel は Git 非接続、リポジトリルート、Next.js、Node 24、システム環境変数の公開を有効にし、Preview を Vercel Authentication で保護します。プロジェクト・共通・連携の環境変数、外部接続、Deployment Protection の自動化バイパスを設定しません。
3. Neon は PR 専用プロジェクトの初期ブランチを `mille-pr-template` とします。標準の空 DB `neondb` とロール `neondb_owner` を保ち、テンプレートに利用者データや追加の DB・ロールを作りません。PR 用ブランチを新規作成する前にテンプレートの DB カタログを読み取り照合します。契約上のブランチ・compute 枠、停止設定と利用量を確認します。異なる PR の起動が重なる場合も、契約上の枠内で処理できることを確認します。
4. GitHub Environment `mille-pr-preview` の許可ブランチを `main` のみに限定し、既存の最小権限資格情報を Environment secrets `VERCEL_TOKEN` と `NEON_API_KEY` に登録します。同じ資格情報が Repository Secrets や PR から参照できる Organization Secrets に公開されていないことを確認します。新規の永続資格情報、権限拡大、追加費用は別途承認が必要です。
5. Environment variables に `MILLE_PR_PREVIEW_VERCEL_TEAM_ID`、`MILLE_PR_PREVIEW_VERCEL_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_TEMPLATE_ID`、`MILLE_PR_PREVIEW_MAX_BRANCHES` を登録します。ブランチ数は割り当て内の値にします。この設定は作成前に確認する運用上限であり、同時に実行される別 PR を含む総量はプロバイダー側の枠で制御します。
6. 導入 PR のレビュー、CI、初回 Preview の検証を済ませ、別途承認を得てマージします。上記の設定とアクセス範囲を照合した後、Repository variable `MILLE_PR_PREVIEW_ENABLED` を `true` に設定すると管理ジョブが起動します。

## URL と Ready 条件

Actions の `Mille PR Preview` で対象 PR の管理ジョブを開き、Summary に記載された完全 SHA が現在の PR HEAD と一致することを確認します。そこに記載された固有の Vercel URL を使います。

同じ HEAD の CI が成功し、正式 Preview の `/api/runtime` が同じ SHA を返し、PC・スマホそれぞれで架空 A/B のログインが成功した時点で Ready とします。正式 Preview は Vercel にログインしたブラウザで確認します。PC とスマホ表示で、それぞれ A/B のログイン・本人表示・ログアウトを確認し、URL・SHA・4 ケースの結果を PR に記録します。ローカル検証の `npm run qa:cloud` も、同じ SHA の clean な checkout で実行します。

導入 PR は自動処理を有効化する前に、承認済みの正規手段で初回専用 Preview を用意して検証します。有効化後は確認用 draft PR で、作成、HEAD 更新後の URL と DB データの維持、別 PR の分離、終了後の専用資源の不在を確認し、結果を記録します。受付ワークフローの改変、対象外ブランチ、古い通知、資源の所有不一致では管理処理を実行しません。マージ競合などで開いている PR の受付が起動しない場合は、競合を解消して最新の変更で通知を発生させます。通知が欠けた場合は、GitHub Actions で `main` の `Mille PR Preview` を手動実行できます。PR 番号と正確な HEAD SHA を入力し、開いていれば `deploy`、閉じていれば `cleanup` を指定します。
