# Cakeに合わせた既存Previewプロジェクトの共用

Issue #32 AC-03 は、既存の Neon プロジェクト `mille-preview` を常設 Preview と PR 専用 Preview で共用する。Cake の共通設定と別々のブランチを参照し、mille の常設用 `main` と空の `mille-pr-template` の接続先を区別する。

未接続リソース照合コマンドを既存の Free Marketplace ストアと `mille-preview` に合わせる。同じプロジェクト内で、常設と分岐元候補に対応する二つの独立した root と endpoint、現在の既定ブランチ、現行 PR 用の子ブランチの所属を照合する。分岐元候補の標準 DB とロールを確認し、構成に応じた接続先だけを出力する。

架空の管理 API 応答で現在・切替後の既定ブランチ、既存 PR、誤った所有や接続先、認証情報の伏せ方を検証する。最終 SHA の独立レビュー、Cloud 検証、push・PR CI と現行 Preview を確認する。

Vercel のストア ID と実際の接続前構成、空の分岐元、常設用スコープを照合する。実際の既定変更と接続は、Native 管理処理・旧管理処理の復旧手順および試験準備が整ってから行う。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32) · [Cake の共通設定](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/preview.config.json)
