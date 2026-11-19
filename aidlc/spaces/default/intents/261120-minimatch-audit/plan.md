# 開発用minimatchの監査指摘を解消する計画

mainの監査に残るGHSA-g3hv-75wg-m249への対応。既存のeslint-config-next宣言に適合するtypescript-eslint 8.73.0へlock更新し、配下のminimatchを修正版にする。

1. 最新mainから専用のdraft PRを作成する。正本Node 24.22.3とnpm 11.19.1、既存lockfileを使い、`npm update typescript-eslint --package-lock-only --ignore-scripts --no-audit --no-fund` を実行する。Cloudの起動失敗時は読み取り権限だけの一時Actionsジョブで生成する。
2. npmの出力をSHA-256とGit blobで照合する。lockfile version、対象依存の版、全minimatchの影響範囲、直接依存とoverridesの維持、関連開発用パッケージだけの更新を確認する。
3. 生成用workflowを削除してlockfileを保存する。別Agentが現在HEADの完全SHAで読み取りレビューし、通常CIで監査・lint・型検査・テスト・build・ブラウザQAを検証する。
4. 監査が報告した残存項目と、CI・独立レビューをPRとIssueに記録する。正式Previewが未検証なのでdraftを維持する。

Node、Next.js、マニフェストとCI基準、アプリ、Vercel・本番環境は更新の対象外。
