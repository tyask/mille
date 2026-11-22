# Native の Git デプロイ作成要求を Cake と揃える

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-03 の [承認済み計画](../261122-native-preview-completion/plan.md) と [承認記録](../261122-native-preview-completion/approvals.json) を引き継ぐ。

試験 A #48 は Vercel の作成要求を送った後、HTTP 400 で止まった。本番と常設 Preview、試験環境の復旧を確認した。同じ Git デプロイ API と環境変数入力を使って `READY` になった Cake の要求と照合し、Mille が追加で渡す `public: false` を Native の作成要求から取り除く。現行コードの Preview 保護の確認と、作成結果が非公開で所有情報が一致することの照合を行う。公開 OpenAPI と照らした検証候補として扱い、拒否理由との因果関係は再試験で確認する。 [試験 A](https://github.com/tyask/mille/actions/runs/44992173021/job/137115486311) · [Cake の成功ジョブ](https://github.com/tyask/Cake/actions/runs/44560139363/job/135687464011) · [Vercel API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)

作成要求は1回とし、プロバイダー・現 HEAD・専用資源を照合する。HTTP 400 の場合に仕様で定義された既知の入力エラーを固定の理由に対応付ける。診断は固定の理由と状態番号だけを記録する。

作成要求の形、作成結果の非公開照合に失敗した場合の停止、既知と未知の HTTP 400、再送を防ぐ動作をテストする。最終 HEAD の独立レビュー、Cloud 検証、CI、従来方式の正式 Preview を確認する。実環境への反映にはマージと一時切替の承認を得て、A の作成結果を照合する。AC-03 はアプリ公開、分離、更新時の保持、クローズとマージ後の実資源削除を確認するまで保留する。
