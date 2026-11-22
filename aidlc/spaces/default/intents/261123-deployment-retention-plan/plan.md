# 旧デプロイの読み取り専用候補一覧

Issue #32 の AC-06 の候補一覧を整備する。対象と承認は [全体計画](../261121-cake-parity-ci/plan.md)、[保存済み Issue](../261121-cake-parity-ci/issue.md)、[別々の承認記録](../261121-cake-parity-ci/approvals.json) を参照する。

Cake の整理手順を参照し、信頼済み `main` の手動ジョブで、Vercel の所有が確認できる旧 `main` 本番デプロイを GET で一覧にする。本番ターゲット、最新 READY、エイリアスと Cron の全参照先、既存の常設固有 URL、PR 専用を含む Preview を保持する。全ページ、Git 出典と本番の履歴、候補ごとの実際のエイリアスを照合し、対象や関連設定の変化を検出した場合は停止する。 [Cake の整理手順](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/.github/workflows/deployment-retention.yml)

関連テスト、完全 SHA の独立レビュー、全テスト・build・ブラウザ QA、GitHub CI と正式 Preview を確認する。既存の CLI 認証で実データの GET のみによる集計も確認する。実削除と午前6時（日本時間）の定期実行は、その実行対象と運用を別途承認してから扱う。
