## 目的・背景

P1aでは検証完了を報告した後に、PRのドラフト解除とIssueの受入条件チェックを更新した。両方の保存状態をGitHubから再取得し、完了報告の前に確認する手順をmilleの開発ルールに組み込む。通常のReadyはCloud検証で判断し、正式Previewのブラウザ確認はReady後に利用者が行う。

## 対象範囲・対象外

- PR #27で `AGENTS.md`、`docs/development.md`、`docs/pr-preview.md` を更新する。
- 既存のGitHubコネクタを使い、検証済みの受入条件と証拠をIssueへ反映する。最終HEADのレビューとCloudテストを確認した時点で、GitHub上でPRをReady for reviewに切り替える。GitHub CIは並行実行し、結果をPRに記録する。
- Ready後に現在HEADに対応する正式Preview URLを案内し、利用者がブラウザで動作を確認する。通常手順から `/api/runtime` の手動SHA照合を外す。
- PRとIssueを再取得して、最終SHA、ドラフト状態、対象の受入条件チェックを確認する。途中で処理が止まったときは、GitHubの保存状態から残りの操作を特定する。

## 受入条件

- [ ] AC-01: `AGENTS.md` に、検証済み受入条件の更新、条件を満たしたPRのReadyへの切り替え、PRとIssueの再取得を完了報告前の手順として明記する。
- [ ] AC-02: `docs/development.md` に、既存コネクタでの更新と再取得、照合する最終SHA・ドラフト状態・受入条件チェックを記載する。SHA不一致、検証不足、更新や再取得の失敗が起きた場合は、残る確認や操作を未完了として報告する。
- [ ] AC-03: PR #24とIssue #23を読み取り専用で再取得し、GitHubに保存された状態で判定できることを確認する。未チェック、ドラフト、SHA不一致の例も手順に照らして確認し、独立レビューと最終HEADの検証結果を作業PRに記録する。
- [ ] AC-04: 3つの文書で、最終HEADのレビュー・Cloudテスト完了後にReadyへ切り替え、正式Previewのブラウザ確認はReady後に利用者が行う順序を揃える。通常手順から `/api/runtime` の手動SHA照合を外し、GitHub CIは並行して結果を記録する。

## 関連記録

- [milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)
- [milleの開発手順](https://github.com/tyask/mille/blob/main/docs/development.md)
- [PR専用Previewの手順](https://github.com/tyask/mille/blob/main/docs/pr-preview.md)
- [P1aのPR #24](https://github.com/tyask/mille/pull/24)
- [P1aのIssue #23](https://github.com/tyask/mille/issues/23)

## 進捗

- チャットで提示した計画に対し、利用者から「承認します。」と回答を得た。GitHubに保存した本Issue本文への別承認後に実装を開始する。
- 保存済みIssue本文への別承認を得て実装した。最終HEAD `7847b283af77cfe0529bbf7e80daa9884c6f30a9` の文書差分と独立レビューでAC-01・AC-02を確認した。 [PR #27](https://github.com/tyask/mille/pull/27)
- Ready前のCloud検証とReady後の利用者確認に変更する計画について、利用者から「承認します」と回答を得た。変更版Issue本文への別承認後にPR #27を更新し、受入条件を新しい最終HEADで再確認する。
