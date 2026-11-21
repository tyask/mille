# Vercel本番のマイグレーション自動化

Issue #32の全体計画のうちAC-02を実装する。AC-01のCIを取り込んだ `main` から開始する。

`vercel.json` で `npm run build:vercel` を指定する。通常のVercel Git本番ビルドは設定済みホスト、`mille-production` の環境ID、`main` を照合してNext.jsをbuildする。成功した場合だけ、既存の初期化なしのマイグレーションを実行する。Neonの実行時設定がプール接続の場合、照合済みの同じエンドポイントの直接ホストを移行だけに使う。SQLの環境識別・ハッシュ照合・アドバイザリロックを継承する。マイグレーションの失敗は公開を止める。

通常のアプリbuild・Runtime・PR専用PreviewのDB管理は現在の入口を使う。テストと使い捨てPGliteで実行順、未適用分・再実行、空DBや別環境・履歴不一致の拒否、失敗時のロールバックを確認する。独立レビュー、最終SHAのCloud検証、pushとPR CI、正式Previewのbuildログを確認する。本番での初回自動実行は別途マージ承認後に確認する。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32) · [Cakeの実装](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/build/vercel-build.ts)
