# 旧デプロイの保持と整理

GitHub Actions の **Mille Deployment Retention** を手動実行し、ブランチに `main` を選びます。実行時点の `main`、Vercel チーム・プロジェクト・GitHub リポジトリの所属を照合し、旧本番デプロイの候補を読み取り専用で一覧にします。終了時にも `main` とデプロイ・参照先の一覧を照合します。

候補になるのは、`tyask/mille` の `main` の履歴と Vercel の Git 出典が一致し、`READY`、`ERROR`、`CANCELED` のいずれかに到達した本番デプロイです。現用エイリアス、プロジェクトターゲットと Cron の参照先、最新の `READY` 本番を保持します。既存の常設 Preview `dpl_PzqN4fUewyF6MtViekWrhWSb5juw` は固有 URL と照合して保持します。PR 専用を含む Preview や、出典・所有を確認できないデプロイも保持します。

Actions の **Summary** には照合した `main` SHA、保護した本番と常設 Preview の ID、候補 ID・SHA・状態を掲載します。参照先の変化や照合エラーがあれば、現時点の設定を確認して計画を再実行します。実削除と午前6時（日本時間）の定期実行は、それぞれ別途承認の対象です。 [Issue #32](https://github.com/tyask/mille/issues/32) · [Cake の保持方針](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/docs/development-workflow.md#L488-L504)
