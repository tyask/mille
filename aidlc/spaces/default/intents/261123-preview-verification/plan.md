# 正式 PR Preview の状態確認とブラウザ検証

Issue #32 の AC-04 を進める。対象と承認は [全体計画](../261121-cake-parity-ci/plan.md)、[保存済み Issue](../261121-cake-parity-ci/issue.md)、[別々の承認記録](../261121-cake-parity-ci/approvals.json) を参照する。

信頼済み `main` の手動実行に、現在の PR HEAD・Vercel の READY アプリ・専用 Neon ブランチ、endpoint と世代の読み取り照合を追加する。検証は取得済みのデプロイ ID を指定し、開始と終了で同じ対象を確認する。Cake と同様に同一プロジェクトの短期 Development OIDC を使い、ブラウザの通信は照合した origin、読み取りとテストアカウントの認証に限定する。PC・スマホ × 架空 A/B の実結果と、アプリと検証コードの SHA を安全な証跡に残す。 [Cake の正式検証](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/docs/development-workflow.md#L507-L555)

現 HEAD の不一致、デプロイや DB の変更、欠けた証跡、認証の適用範囲を回帰テストする。追加ページの初回通信を制限し、検証ブラウザの文書ポリシーで Worker を制限する。架空ユーザーの初回アクセス時は、アプリが通常の初期化で個人ワークスペースを作成する場合がある。既存のローカル QA、最終 SHA の独立レビュー、push と PR の CI、正式 Preview を確認する。新操作を `main` から実際に検証できた後に、正式 Preview とアプリ変更時の証跡を Ready 条件へ切り替える。Ready 後に追修正する場合は先に draft に戻す。 [Cake の Ready 条件](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/docs/development-workflow.md#L569-L615)
