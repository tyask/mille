# Neon Native Previewの準備用ビルド

Issue #32 AC-03のうち、Native分岐を待つ静的な準備用ビルドを実装する。Cakeの準備用Build Output API v3と同じ構成をmilleに導入する。

Vercelのホストビルド、Preview、milleのGitHubリポジトリ、PR、ブランチ、完全SHAと世代の対応を照合する。明示された準備フェーズでは `.next/output` にルートのGETとHEADを受ける静的ページを生成する。Next.jsのアプリbuildやDB処理は実行せず、他のパスとメソッドは404を返す。通常ビルドへの切替時は、準備用と確認できる成果物を除去する。

一時ディレクトリと架空設定で対象チェック、出力、既存成果物の分離、通常ビルド、本番ビルドの回帰を検証する。最終SHAの独立レビュー、Cloud検証、push・PR CI、現行PR専用Previewを照合する。

AC-03の次段階で、空の既定ブランチを用意し、VercelのPreview限定連携、GitHubソースによる準備用デプロイ、Native側の所有・分離・保持・削除を検証する。外部設定の切替は別途承認を受ける。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32) · [Cakeの準備用ビルド](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/build/preview-provisioning.ts)
