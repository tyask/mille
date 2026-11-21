# Ready前のCloud検証とReady後の利用者確認を明記する計画

- PR #27で `AGENTS.md`、`docs/development.md`、`docs/pr-preview.md` を更新する。
- 最終HEADのレビューとCloudテストが完了したら GitHub 上で Ready for review に切り替える。GitHub CIとPreviewの作成は並行で進め、状況と結果をPRに記録する。
- Ready後に現在HEADに対応する正式Preview URLを案内し、利用者がブラウザで確認する。通常の確認手順から `/api/runtime` の手動SHA照合を外す。
- 最終SHAのレビューとCloudテストを再実行し、保存したPRとIssueを照合して受入条件とReady状態を報告する。
