# Native Preview の照合を Cake の方式に揃える

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-03 を進めるため、既存の `VERCEL_TOKEN` と `NEON_API_KEY` で Native Preview の対象を照合する。 [Cake の照合処理](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/preview/preview-provider.ts#L41-L49)

Native 試験の作成・削除、Actions 診断、ローカルの切替前確認から Marketplace ストア API とストア・構成・製品 ID の入力を取り除く。切替時に、既存ストアの接続と自動分岐がともに Preview 限定であることを Vercel の画面で確認する。

現在の PR と HEAD、Vercel のプロジェクトとデプロイ、Neon のプロジェクトと親ブランチを照合する。静的デプロイに注入された接続先を専用エンドポイントに照合し、既定・常設・先行試験 PR からの分離を確認してから DB を初期化する。所有を確認した資源を削除し、その不在を確認する。

既存資格情報での読み取り診断と、照合不一致で資源変更の前に止まることをテストする。独立レビュー、最終 HEAD の Cloud 検証、CI、従来方式の正式 Preview を確認する。新しい PR を作成後に PR #43 と相互に関連付けて差し替え、PR #43 に属する専用 Preview 資源の削除を確認する。

マージと外部設定の切替は別途承認を受ける。復旧済み構成での診断後に Native 試験を進め、実分岐、注入資格情報の分離、更新時のデータ保持、終了時の削除の証拠が揃うまで AC-03 を保留する。
