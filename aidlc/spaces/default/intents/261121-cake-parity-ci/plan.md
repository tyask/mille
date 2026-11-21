# Cakeに揃える開発・デプロイ運用

- CIと開発手順を揃え、push・PRの最新試行とテスト対象コミットを確認する。
- Vercelの本番は、Next.jsのビルド成功後に本番DBの未適用SQLを反映してから公開する。
- Neon Native方式のPR専用Previewへ移行する。正式Previewのブラウザ検証結果を確認できるようになってからReady条件を切り替える。
- mainと同じコミットの常設Previewを検証し、固定エイリアスを更新する。CI・本番・常設Preview・PR専用資源の削除をマージ後に照合し、結果をIssueへ記録する。
- 旧デプロイの候補を読み取り専用で照合し、実削除の承認後に毎朝6時（日本時間）の整理を有効にする。

## 今回の実装範囲

Issue #32のAC-01。CIのイベント・固定イメージ・Actions・証拠、依存境界・文書検査、Issue・PRテンプレート、Intent・検証手順を整備する。依存監査は個別コマンドで実行する。GitHub PRチェックでは検証したマージコミットとPRの元HEADを区別し、pushチェックでは元HEADを検証する。

最終コミットで独立レビュー、check:fast、全テスト、build、CloudブラウザQAを行う。GitHubのpush・PR CIと正式Previewを、承認済みの開発手順に沿って照合する。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32)
