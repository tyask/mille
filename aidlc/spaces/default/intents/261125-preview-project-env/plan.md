# 正式PR PreviewでVercelの共通環境変数を利用する計画

- 正式PR Previewの事前検査で、Vercelのプロジェクト共通のPreview環境変数の存在を理由とする停止条件を外す。環境変数の割り当てはVercelの設定に従う。
- 模擬設定で共通環境変数を許可することを確認し、既存のブランチ指定、外部接続、Deployment Protection、リポジトリ・デプロイ・専用DBの照合を回帰テストする。
- 最終SHAの独立レビュー、Cloud検証、GitHub CI、正式PR Previewの証跡を揃える。利用者によるVercelへの一度の登録と、新しいデプロイへの反映を運用手順に記録する。実モデル試験はIssue #74で扱う。

[承認済み Issue #76](https://github.com/tyask/mille/issues/76)
