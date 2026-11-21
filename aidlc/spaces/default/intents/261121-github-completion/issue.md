## 目的・背景

P1aでは検証完了を報告した後に、PRのドラフト解除とIssueの受入条件チェックを更新した。両方の保存状態をGitHubから再取得し、完了報告の前に確認する手順をmilleの開発ルールに組み込む。

## 対象範囲・対象外

- `AGENTS.md` の完了条件と `docs/development.md` の操作手順を更新する。
- 既存のGitHubコネクタを使い、検証済みの受入条件と証拠をIssueへ反映する。現在HEADの検証と既存のReady条件を照合して、GitHub上でPRをReady for reviewに切り替える。
- PRとIssueを再取得して、最終SHA、ドラフト状態、対象の受入条件チェックを確認する。途中で処理が止まったときは、GitHubの保存状態から残りの操作を特定する。

## 受入条件

- [ ] AC-01: `AGENTS.md` に、検証済み受入条件の更新、条件を満たしたPRのReadyへの切り替え、PRとIssueの再取得を完了報告前の手順として明記する。
- [ ] AC-02: `docs/development.md` に、既存コネクタでの更新と再取得、照合する最終SHA・ドラフト状態・受入条件チェックを記載する。SHA不一致、検証不足、更新や再取得の失敗が起きた場合は、残る確認や操作を未完了として報告する。
- [ ] AC-03: PR #24とIssue #23を読み取り専用で再取得し、GitHubに保存された状態で判定できることを確認する。未チェック、ドラフト、SHA不一致の例も手順に照らして確認し、独立レビューと最終HEADの検証結果を作業PRに記録する。

## 関連記録

- [milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)
- [milleの開発手順](https://github.com/tyask/mille/blob/main/docs/development.md)
- [P1aのPR #24](https://github.com/tyask/mille/pull/24)
- [P1aのIssue #23](https://github.com/tyask/mille/issues/23)

## 進捗

- チャットで提示した計画に対し、利用者から「承認します。」と回答を得た。GitHubに保存した本Issue本文への別承認後に実装を開始する。
