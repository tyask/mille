# P2 OpenAI 直接接続の正式 Preview 検証計画

- OpenAI Chat Completions API へのリクエストに `store: false` を指定する。ZDR の有効化と確認を、実モデル試験と今後の利用の前提条件から外す。模擬テストで送信内容を確認する。
- 利用者が登録した Vercel の Preview 専用プロジェクト共通 Secret を使う。新規 Preview にビルド時と実行時の環境変数として適用される。Cloud・CI では模擬応答を使い、正式 Preview の自動検証ではテスト認証と読み取りを行う。
- モデル利用可否と既存 API クレジットは利用者の確認を記録する。保護付き PR #75 専用 Preview の完全 HEAD、デプロイ ID、専用 DB と移行007を照合する。実モデルは明示的に有効化し、架空ユーザーの提案・修正、予定保存、実績化を確認する。試験は最大10回で、成否にかかわらず無効化して件数を確認する。
- 実行したモデル、リクエスト ID、所要時間、トークン数、費用の証跡と、対象 HEAD の独立レビュー、Cloud・CI・正式 Preview の検証結果を記録する。

[承認済み Issue #74](https://github.com/tyask/mille/issues/74) · [先行する直接接続の Intent](../261125-suggestion-openai/intent.json) · [共通 Preview 環境変数 Issue #76](https://github.com/tyask/mille/issues/76)
