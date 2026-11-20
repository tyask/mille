# PR 専用 Preview

同一リポジトリの `codex/*` から `main` に向けた PR が対象です。draft も含みます。PR の作成・更新・再オープン・クローズを `Mille PR Events` が受け付けます。merge 時は `main` の push も照合します。受付ではコードの checkout や外部サービスの操作を行いません。

`Mille PR Preview` は `main` 上のコードで、通知元、PR の所属、対象ブランチ、HEAD、状態を GitHub API で照合します。管理ジョブは PR ごとに直列化し、操作直前にも状態を確認します。PR のソースは照合済みの SHA から Git オブジェクトとして取り出し、ビルドは Vercel 上で行います。PR のコードを管理ジョブで実行することはありません。

Neon の PR 専用ブランチで、承認済みの適用済み SQL と原文が一致することを確かめ、現在の PR HEAD の migration と架空 A/B を適用します。同じ PR を更新しても DB を維持します。main に migration が追加された場合は、その原本を含むよう作業ブランチを更新してから再実行します。PR の終了時は所有を照合した Vercel デプロイと Neon ブランチを順に削除します。再実行は同じ PR の既存リソースを照合します。失敗時は管理ジョブの停止工程、PR 番号、SHA を確認し、所有を確認できないリソースは運用担当者が調査します。

## 有効化

1. 既存の Vercel `mille`（GitHub `tyask/mille` に接続済み）と Neon `mille-preview` を確認します。常設 Preview の正確な URL、対応する Deployment ID、DB の branch・endpoint と接続先を読み取りで記録します。常設 URL が個別 Deployment の URL の場合はその Deployment を保持します。本番ブランチが `main` であることと、本番用 alias の現在の参照先を照合します。
2. 常設 DB の接続情報と認証設定は、信頼済みの常設用 Git ブランチに適用範囲を限定します。変更前の適用先と復旧手順を確認し、既存の常設 Preview が同じ URL と DB で応答することを確かめます。接続情報の値は取得・再入力せず環境変数の適用範囲を変更します。管理ジョブは、共通または `codex/*` に適用される Preview 変数や Deployment Protection の自動化バイパスがある場合は停止します。
3. 通常のブランチ push による自動デプロイを制御します。管理ジョブは、信頼済み main と現在の PR HEAD の両方に `vercel.json` の同じ Git 制御設定があることを要求します。この照合は管理ジョブ向けです。Vercel の Git 連携が実際に採用する設定を確認し、設定を含まない旧 ref や対象外の通常の push でも PR Preview が起動しないことを照合します。起動範囲を制御できない場合は有効化を止めます。
4. Neon Native Preview Branching は設定と分岐元を確認します。既存の常設 DB を含むブランチが分岐元になる場合は、その構成で有効化しません。同じ `mille-preview` 内の独立した空の `mille-pr-template` を管理ジョブに指定して PR ごとの子ブランチを作ります。テンプレートには標準の空 DB `neondb` と分離されたロール `neondb_owner` を用意します。既定ブランチには変更を加えず、ブランチと compute の利用枠を照合します。空の root がなければ schema-only で独立した root を作成し、既定ブランチと異なる ID・endpoint を照合した後、その隔離先でだけ既存スキーマを除きます。テンプレートに旧ロールのパスワードが引き継がれた場合は、隔離先の資格情報のみを分離します。その発行が必要な場合は別途承認を得ます。Vercel 側の Native の接続状態と、別の DB 接続情報が PR に注入されないことも確認します。
5. GitHub Environment `mille-pr-preview` の許可ブランチを `main` のみに限定し、既存の最小権限資格情報を Environment secrets `VERCEL_TOKEN` と `NEON_API_KEY` に登録します。Environment variables は `MILLE_PR_PREVIEW_VERCEL_TEAM_ID`、`MILLE_PR_PREVIEW_VERCEL_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_TEMPLATE_ID`、`MILLE_PR_PREVIEW_MAX_BRANCHES` を使用します。
6. 導入 PR の独立レビュー、CI、初回正式 Preview での検証を済ませ、別途承認を得てマージします。すべての設定を照合した後に Repository variable `MILLE_PR_PREVIEW_ENABLED` を `true` にします。常設 URL・DB の維持や接続情報の分離が確認できない場合は切替を停止します。追加費用、永続資格情報の発行、権限拡大には別途承認が必要です。

## URL と Ready 条件

Actions の `Mille PR Preview` で対象 PR の管理ジョブを開き、Summary に記載された完全 SHA が現在の PR HEAD と一致することを確認します。そこに記載された固有の Vercel URL を使います。

同じ HEAD の CI が成功し、正式 Preview の `/api/runtime` が同じ SHA を返し、PC・スマホそれぞれで架空 A/B のログインが成功した時点で Ready とします。正式 Preview は Vercel にログインしたブラウザで確認します。PC とスマホ表示で、それぞれ A/B のログイン・本人表示・ログアウトを確認し、URL・SHA・4 ケースの結果を PR に記録します。ローカル検証の `npm run qa:cloud` も、同じ SHA の clean な checkout で実行します。

導入 PR は自動処理を有効化する前に、承認済みの正規手段で初回専用 Preview を用意して検証します。有効化後は確認用 draft PR で、作成、HEAD 更新後の URL と DB データの維持、別 PR の分離、終了後の専用資源の不在を確認し、結果を記録します。受付ワークフローの改変、対象外ブランチ、古い通知、資源の所有不一致では管理処理を実行しません。受付の導入・変更より前から作業中のブランチは最新の main を取り込みます。マージ競合で開いている PR の受付が起動しない場合は、競合を解消して最新の変更で通知を発生させます。通知が欠けた場合は、GitHub Actions で `main` の `Mille PR Preview` を手動実行できます。PR 番号と正確な HEAD SHA を入力し、開いていれば `deploy`、閉じていれば `cleanup` を指定します。
