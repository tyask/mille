## 目的・背景

Vercelのプロジェクト共通のPreview環境変数を一度登録し、以降の正式PR Previewで使えるようにします。現行の管理ジョブは共通のPreview環境変数があると事前検査で停止するため、Preview専用の `OPENAI_API_KEY` を登録すると作成や検証が止まります。

## 対象範囲・対象外

- 現行の正式PR Preview管理から、プロジェクト共通のPreview環境変数があることを理由に停止する判定を外します。環境変数の割り当てはVercelの設定に従います。
- 既存のブランチ指定の確認、外部接続の検査、Deployment Protection、リポジトリ・デプロイ・専用DBの照合を回帰テストで確認します。
- 管理コード、テスト、運用手順を対象とします。Vercelへの実キーの登録は利用者が行い、OpenAIの実モデル試験はIssue #74で扱います。

## 受入条件

- [ ] AC-01: Vercelのプロジェクト共通のPreview環境変数を含む模擬設定で、正式PR Previewの事前検査が通ります。ブランチ指定、外部接続、Deployment Protection、所有や対象の不一致に対する既存の検査を確認します。
- [ ] AC-02: 最終SHAの独立レビュー、Cloud検証、GitHub CIと正式PR Previewの証跡を記録します。Vercelへの登録手順と、共通設定が登録後の新しいデプロイに適用されることを運用手順に記録します。

## 関連記録

- [Issue #74](https://github.com/tyask/mille/issues/74) · [ドラフトPR #75](https://github.com/tyask/mille/pull/75)
- [正式PR Previewの管理コード](https://github.com/tyask/mille/blob/main/scripts/preview/vercel.ts#L172) · [運用手順](https://github.com/tyask/mille/blob/main/docs/pr-preview.md)
- [Vercelの環境変数](https://vercel.com/docs/environment-variables/managing-environment-variables) · [Milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md#承認と完了条件)

## 進捗

- 利用者から、プロジェクト共通のPreview環境変数を理由に止めるチェックを外す指示を受けました。GitHubに保存した本Issue本文への承認後に実装します。