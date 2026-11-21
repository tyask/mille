# Neon Native Previewの未接続リソース照合

Issue #32 AC-03 のうち、専用の未接続リソースを作成後に、Vercel と Neon の管理 API から読み取りで照合する。

Vercel の指定チームと Marketplace ストア、Neon 製品とインストール、Free プラン、接続先0件、Neon プロジェクト ID の対応を照合する。Neon 側では専用プロジェクトと組織、シンガポール、Marketplace 由来、親のない既定ブランチ1件と同じブランチの読み書き用 endpoint・標準DB・所有ロールを照合する。認証情報や応答本文を出力せず、照合した識別子を結果に出す。

架空の provider 応答を使い、別プロジェクト、接続済み、プラン不一致、一覧不完全、エラーの伏せ方を検証する。最終 SHA の独立レビュー、Cloud 検証、両 GitHub CI と現行 Preview を確認する。

実際の専用リソースの作成は承認済み。作成後に管理 API の証拠と専用 DB の読み取り専用 SQL を照合する。Vercel や GitHub の接続・運用切替はこの変更とは別の工程とする。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32) · [Neon Marketplace の作成手順](https://neon.com/docs/guides/vercel-managed-integration#add-another-database-project)
