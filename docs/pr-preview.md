# PR 専用 Preview

同一リポジトリの `codex/*` から `main` に向けた PR が対象です。draft も含みます。PR の作成・更新・再オープン・クローズを `Mille PR Events` が受け付けます。merge 時は `main` の push も照合します。受付ではコードの checkout や外部サービスの操作を行いません。

`Mille PR Preview` は `main` 上のコードで、通知元、PR の所属、対象ブランチ、HEAD、状態を GitHub API で照合します。管理ジョブは PR ごとに直列化し、操作直前にも状態を確認します。PR のソースは照合済みの SHA から Git オブジェクトとして取り出し、ビルドは Vercel 上で行います。PR のコードを管理ジョブで実行することはありません。

Neon の PR 専用ブランチで、承認済みの適用済み SQL と原文が一致することを確かめ、現在の PR HEAD の migration と架空 A/B を適用します。同じ PR を更新しても DB を維持します。main に migration が追加された場合は、その原本を含むよう作業ブランチを更新してから再実行します。PR の終了時は所有を照合した Vercel デプロイと Neon ブランチを順に削除します。再実行は同じ PR の既存リソースを照合します。失敗時は管理ジョブの停止工程、PR 番号、SHA を確認し、所有を確認できないリソースは運用担当者が調査します。

## 有効化

1. 既存の Vercel `mille`（GitHub `tyask/mille` に接続済み）と Neon `mille-preview` を確認します。常設 Preview の正確な URL、対応する Deployment ID、DB の branch・endpoint と接続先を読み取りで記録します。常設 URL が個別 Deployment の URL の場合はその Deployment を保持します。本番ブランチが `main` であることと、本番用 alias の現在の参照先を照合します。
2. 常設 DB の接続情報と認証設定は、信頼済みの常設用 Git ブランチに適用範囲を限定します。変更前の適用先と復旧手順を確認し、既存の常設 Preview が同じ URL と DB で応答することを確かめます。接続情報の値は取得・再入力せず環境変数の適用範囲を変更します。管理ジョブは、共通または `codex/*` に適用される Preview 変数や Deployment Protection の自動化バイパスがある場合は停止します。
3. 通常のブランチ push による自動デプロイを制御します。管理ジョブは、信頼済み main と現在の PR HEAD の両方に `vercel.json` の同じ Git 制御設定があることを要求します。この照合は管理ジョブ向けです。Vercel の Git 連携が実際に採用する設定を確認し、設定を含まない旧 ref や対象外の通常の push でも PR Preview が起動しないことを照合します。起動範囲を制御できない場合は有効化を止めます。
4. 現行の管理ジョブは、`mille-preview` 内の独立した空の `mille-pr-template` から、PR ごとの子ブランチを作ります。テンプレートには標準の空 DB `neondb` と分離されたロール `neondb_owner` を用意します。空の root がなければ schema-only で独立した root を作成し、既定ブランチと異なる ID・endpoint を照合した後、その隔離先でだけ既存スキーマを除きます。テンプレートに旧ロールのパスワードが引き継がれた場合は、隔離先の資格情報を分離します。その発行が必要な場合は別途承認を得ます。ブランチと compute の利用枠を確認します。
5. GitHub Environment `mille-pr-preview` の許可ブランチを `main` のみに限定し、既存の最小権限資格情報を Environment secrets `VERCEL_TOKEN` と `NEON_API_KEY` に登録します。Environment variables は `MILLE_PR_PREVIEW_VERCEL_TEAM_ID`、`MILLE_PR_PREVIEW_VERCEL_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_PROJECT_ID`、`MILLE_PR_PREVIEW_NEON_TEMPLATE_ID`、`MILLE_PR_PREVIEW_MAX_BRANCHES` を使用します。
6. 導入 PR の独立レビュー、CI、初回正式 Preview での検証を済ませ、別途承認を得てマージします。すべての設定を照合した後に Repository variable `MILLE_PR_PREVIEW_ENABLED` を `true` にします。常設 URL・DB の維持や接続情報の分離が確認できない場合は切替を停止します。追加費用、永続資格情報の発行、権限拡大には別途承認が必要です。

## Neon Native の準備用ビルド

Neon Native への移行に備え、Vercel のビルドコマンドに静的な準備フェーズを用意します。今後の信頼済み `main` の管理ジョブが、GitHub 上で PR 番号と Git ソースの対応を照合し、世代 ID と `MILLE_NATIVE_PREVIEW_PHASE=provision` をデプロイごとに渡す設計です。ビルドは Vercel 上の組み込み Preview と `AUTH_MODE=test` を確認し、リポジトリ、`codex/*` のブランチ、ソースの完全 SHA を Vercel の情報と照合します。PR 番号と世代 ID の形式を確認し、Vercel から PR 番号も渡された場合は依頼時の番号と照合します。

準備フェーズは `.next/output` に静的ページだけを生成します。ルート `/` の `GET`・`HEAD` に応答し、それ以外のパスやメソッドには `404` を返します。Next.js のアプリビルド、DB 接続、migration、seed は準備フェーズでは行いません。検証用 URL は、専用 DB の照合と後続のアプリデプロイの成功後に案内します。 [Cake の準備用ビルド](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/build/preview-provisioning.ts#L10-L56)

## Neon Native の Git ソース確認

GitHub Actions の `Mille PR Preview` で **Run workflow** を開き、ブランチに `main`、操作に `inspect-native` を選びます。`pr` に PR 番号、`sha` に確認する現在 HEAD の完全 SHA を入力して実行します。この操作はワークフローが `main` に導入された後に利用できます。

`main` 上の確認コードが、同じリポジトリの `codex/*` から `main` に向けた開いている PR と指定した HEAD を GitHub API で照合します。該当コミットの `vercel.json` と `package.json` を読み取り、Git 制御設定と準備用ビルドコマンドを確認します。確認後に PR の状態と HEAD を再取得し、同じ対象であれば Vercel の GitSource に使用する候補を記録します。

実行結果は Actions の該当 run の **Summary** にある `Inspect Native Preview Git source` の結果を確認します。この確認は GitHub の読み取り権限だけで実行し、PR コードの実行、通知、Vercel デプロイ、プロバイダー設定や DB の変更は行いません。

## Neon Native の接続と切替計画

既存の `mille-preview` の既定ブランチは常設 Preview の DB を含み、Native 連携は既定ブランチから分岐します。Free の利用枠を確認し、専用の `mille-native-preview` プロジェクトに空の既定ブランチを用意する計画です。既存 Vercel プロジェクトの組み込み Preview に限定して接続し、既存の接続変数と重複しない Native 専用の接頭辞を使います。本番と常設 Preview の接続先、URL、保護設定を保持します。 [Neon の Vercel 管理連携](https://neon.com/docs/guides/vercel-managed-integration#enable-automated-preview-branching-recommended)

Native 用の管理処理と接続先の照合を実装し、プロバイダー設定変更の別承認を得てから、試験用 PR で動作を確認します。管理ジョブで準備用デプロイのビルド定義と成果物を照合し、静的ページだけが公開されることを確かめてから、専用 DB の準備に進みます。PR・現在 HEAD・Deployment・Neon branch・endpoint・世代を照合し、同じ PR の更新でデータが維持され、別の PR と分離されることを確認します。マージとクローズ後は専用資源の不在を確認します。これらの確認を終えるまでは、現行の管理ジョブと手動の `deploy`・`cleanup` を使います。 [Cake のデプロイ手順](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/preview/preview-service.ts#L50-L97)

## URL と Ready 条件

最終 HEAD の独立レビューと [Cloud での最終検証](development.md#最終検証初回-preview)が完了したら、GitHub 上で PR を Ready for review に切り替えます。GitHub CI と正式 Preview の作成は並行で進め、状況と結果を PR に記録します。

Ready 後の正式 Preview 確認は利用者が Vercel にログインしたブラウザで行います。案内するときは、Actions の `Mille PR Preview` 管理ジョブの Summary で現在の PR HEAD に対応する固有の Vercel URL を確認し、PR に記録して共有します。利用者から確認結果を受け取ったら、PR に追記します。

導入 PR は自動処理を有効化する前に、承認済みの正規手段で初回専用 Preview を用意して検証します。有効化後は確認用 draft PR で、作成、HEAD 更新後の URL と DB データの維持、別 PR の分離、終了後の専用資源の不在を確認し、結果を記録します。受付ワークフローの改変、対象外ブランチ、古い通知、資源の所有不一致では管理処理を実行しません。受付の導入・変更より前から作業中のブランチは最新の main を取り込みます。マージ競合で開いている PR の受付が起動しない場合は、競合を解消して最新の変更で通知を発生させます。通知が欠けた場合は、GitHub Actions で `main` の `Mille PR Preview` を手動実行できます。PR 番号と正確な HEAD SHA を入力し、開いていれば `deploy`、閉じていれば `cleanup` を指定します。
