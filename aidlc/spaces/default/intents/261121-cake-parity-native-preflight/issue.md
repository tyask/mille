## 目的・背景

Cakeの現行手順を基準に、milleのCI、本番DBマイグレーション、PR専用PreviewとReady、常設Previewとマージ後確認、旧デプロイ整理を揃える。全工程をこのIssueで追跡し、段階ごとにPRと検証結果を関連付ける。

## 対象範囲・対象外

- 開発・デプロイ運用を対象とする。献立画面などのアプリ機能は各機能の開発工程で扱う。
- mille専用のリポジトリ、デプロイ、DB、資格情報を使う。信頼済みの `main` から管理し、PRのソースを管理資格情報付きで実行しない。既存の本番DB識別・SQLハッシュ照合と、Previewの本番分離を使う。
- 各段階でテスト、最終コミットの独立レビューとCloud検証、GitHub CIを行い、結果をPRに記録する。新しい確認を実測してから対応する運用を切り替える。マージ、本番操作、外部設定の切り替え、実削除の有効化は別途承認を受ける。

## 受入条件

- [ ] AC-01: `main` と `codex/**` へのpush、`main` 向けPRでCIを実行する。固定したActionsとPlaywright環境で、構造・文書検査、全テスト、build、Cloud QAを行い、現HEADに対応する最新のpush・PR検証結果を確認できる。Issue・PRテンプレート、Intentと検証記録の手順を揃え、既存の依存脆弱性監査は個別コマンドとして利用できる。
- [ ] AC-02: Vercelの本番ビルドでNext.jsのbuild成功後、公開前に既存ランナーが接続先・DBの環境識別・適用済みSQLのハッシュを照合し、未適用分だけを順に適用する。差分なし、増分適用、ビルド失敗時にDB処理へ進まないこと、接続先・履歴の不一致や移行失敗で公開が止まることを検証する。初期化とseedは専用手順で扱う。
- [ ] AC-03: PR専用PreviewでNeon Nativeの分岐を導入する。常設DBや本番DBのデータを引き継がない、専用の空の既定ブランチを確保する。PRと現HEAD、Vercelデプロイ、DBブランチ・エンドポイント・世代を照合する。PR間の分離、同じPRのデータ保持、マージ・クローズ時の専用資源削除を確認する。
- [ ] AC-04: 信頼済みの `main` から正式Previewの状態確認と再検証を行い、PC・スマホ × 架空A/Bのブラウザ検証を現HEADの証拠として保存する。利用可能と確認してから、Cakeに沿って現HEADのCI、独立レビューとCloud検証、正式Previewとアプリ変更時の正式ブラウザ検証をReady条件にする。Ready後の修正はdraftに戻して新しいHEADを再検証する。
- [ ] AC-05: `main` と同じコミットを常設Previewにデプロイする。正式ブラウザ検証が成功してから固定エイリアスを更新し、既存の常設URLとDBを維持する。マージ後はmain CI、本番デプロイとエイリアス、常設Preview、PR専用資源の削除を同一コミットに対応付け、IssueにPRごとの結果を記録する。案件完了を指定したPRで、関連する検証と手動確認がすべて揃った場合にIssueを閉じる。
- [ ] AC-06: 旧デプロイ整理は最初に読み取り専用で削除候補を一覧化する。現用エイリアスや既存の常設URL、進行中のデプロイ、PR専用資源を保護し、承認された候補だけを削除直前と直後に照合する。実削除の承認後に、毎朝6時（日本時間）の実行を有効にする。

## 関連記録

- [Cakeの開発・QA手順](https://github.com/tyask/Cake/blob/main/docs/development-workflow.md)
- [Cakeの本番ビルド](https://github.com/tyask/Cake/blob/main/scripts/build/vercel-build.ts)
- [Cakeの旧デプロイ整理](https://github.com/tyask/Cake/blob/main/.github/workflows/deployment-retention.yml)
- [milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)
- [milleのPR専用Preview手順](https://github.com/tyask/mille/blob/main/docs/pr-preview.md)

## 進捗

- チャットで提示した全体計画に対し、利用者から「承認します」と回答を受けた。GitHubに保存したIssue本文への別承認後に実装を開始する。