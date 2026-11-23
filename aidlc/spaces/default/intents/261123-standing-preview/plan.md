# 常設 Preview の初回切替

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-05 のうち、初回の常設 Preview デプロイと固定 URL の割り当てを対象にする。元の契約は [承認済み計画](../261121-cake-parity-ci/plan.md)、[保存済み Issue](../261121-cake-parity-ci/issue.md)、[別々の承認記録](../261121-cake-parity-ci/approvals.json) を参照する。

利用者は既存固有 URL を維持し、固定 URL `mille-main-preview-fumin1.vercel.app` を追加する構成を選んだ。会話で「AC-05 の初回切替と AC-06 の実削除を承認」と明示した。常設 DB で確認した適用済み001・002を保持し、承認された未適用003・004を既存移行ランナーで適用する。外部切替を実行するワークフローを `main` に導入するマージは別承認とする。

Cake と同じく、信頼済み `main` と CI・本番を照合し、保護付き Preview の固有 URL で正式ブラウザ4ケースを確認してから固定エイリアスを割り当てる。Mille の既存常設 DB と Git ツリーアップロード経路を使う。固有 URL と DB、現用本番の参照先を工程の前後で照合する。最初に割り当てた固定 URL は、割り当て後の確認に失敗した場合に、その割り当ての所有と ID を再取得して取り消す。競合時は確認できた直前の非公開 Preview を照合して参照を復元し、照合結果を識別子で記録する。 [Cake の常設 Preview 処理](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/scripts/preview/staging-workflow.ts)

移行履歴、接続先と保護、固有 URL・固定 URL、実行時 SHA、ブラウザ失敗時の停止、途中失敗の再照合をローカルで検証する。最終 HEAD の独立レビュー、check:fast、全テスト、build、ローカル QA、GitHub CI、専用の正式 Preview の状態とブラウザ検証を確認する。マージ後は承認済みの初回切替を `main` から実行し、結果を Issue に記録する。PR ごとのマージ後照合と Issue 完了処理は AC-05 の後続段階とする。
