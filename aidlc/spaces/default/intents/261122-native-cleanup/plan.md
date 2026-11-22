# Native Preview のクローズ時に残る Vercel デプロイの修正

[承認済みの AC-03 計画](../261122-native-application/plan.md) の専用資源削除を継続する。Issue #32 の保存済み本文と別々の承認は [承認時の記録](../261122-native-application/approvals.json) を参照する。

試験 A #57 のクローズ後、Vercel のエイリアスを直接取得すると 404、デプロイの割り当て一覧は空だった。デプロイ詳細には同じエイリアス名が残り、初回と再試行の管理ジョブが停止した。 [初回](https://github.com/tyask/mille/actions/runs/45007666929/attempts/1) · [再試行](https://github.com/tyask/mille/actions/runs/45007666929/attempts/2)

固定ホスト名とデプロイの所有を照合し、現在のエイリアス割り当てはデプロイの割り当て一覧とエイリアスの直接取得で確認する。割り当て一覧が完全で空、直接取得が 404 のときは、デプロイ詳細に固定ホスト名が残っていても、所有を照合したデプロイの削除を続ける。Cake の PR 終了処理と同じく、削除後にデプロイの直接取得と一覧上の不在を確認する。 [Cake の削除処理](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/scripts/preview/preview-service.ts#L99-L136)

実際の Vercel 応答の組み合わせを再現し、初回の削除と途中からの再開を検証する。割り当て一覧に記載があり直接取得が 404 の場合や、想定外の割り当てがある場合は削除前に停止することを確認する。最終 SHA の独立レビュー、ローカル検証、GitHub CI と正式 Preview を照合する。クローズとマージでの自動削除は、修正のマージと再試験の承認後に実資源で検証する。
