# Neon Native PreviewのGitソース照合

Issue #32 AC-03 のうち、信頼済みの main から Native 分岐に渡す PR の Git ソースを読み取りで照合できるようにする。

現行の Mille PR Preview に手動の inspect-native 操作を追加する。GitHub から同一リポジトリ・現 HEAD・main 向け・codex/* の PR と作成時刻を確認する。既存の Git ポリシーと Git オブジェクト取得を使って Vercel と npm のビルド設定を照合し、完了直前にも PR とソースを確認する。手動ジョブは GitHub の読取権限で実行し、現行の deploy と cleanup の条件を維持する。

リポジトリ・ブランチ・SHA・ビルド設定の不一致、照合中の PR 更新、手動操作と既存ジョブの分離を検証する。最終 SHA の独立レビュー、Cloud 検証、両 GitHub CI、現行 Preview の証拠を記録する。

Neon と Vercel のリソース照合、Native デプロイと DB 管理は後続工程とする。専用 Neon プロジェクトの作成承認は受領済みで、Vercel への接続は別途承認で扱う。

[Issue #32](https://github.com/tyask/mille/issues/32) · [Cake のデプロイ手順](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/preview/preview-service.ts#L50-L97)
