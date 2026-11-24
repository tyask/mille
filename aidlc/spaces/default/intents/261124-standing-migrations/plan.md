# 常設PreviewのDB自動移行の実装計画

常設Previewの既存リリース処理と運用手順を更新する。専用DBの接続先と移行履歴を照合し、Vercelのビルドが成功したら、信頼済み main の未適用SQLだけを番号順に適用する。将来の連番ファイルを同じ手順で検出する。

移行と既存のブラウザQAが成功してから固定URLを切り替える。ビルド・照合・移行・QAに失敗した場合は固定URLの切り替えを止め、従来の版の配信を維持する。

使い捨てDBで増分適用、再実行、既存履歴の保持、異常時に公開が止まることを検証する。最終SHAで独立レビュー、Cloud、GitHub CI、正式PR Previewを確認し、マージ後は同じSHAの常設Previewと固定URLを照合する。

[承認済み Issue #72](https://github.com/tyask/mille/issues/72)
