# Neon Native Preview のストア読み取り資格情報を分ける

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-03 で、Actions の診断と Native 試験が承認済みの Marketplace ストアを照合できるようにする。

GitHub Environment `mille-pr-preview` の `VERCEL_NATIVE_PREVIEW_STORE_TOKEN` を、診断と Native 試験の対象ストアへの固定 HTTPS GET に使う。プロジェクトやデプロイに関する Vercel API、作成と削除には既存の `VERCEL_TOKEN` を使う。

チームの資格情報の送信先、取得拒否や未設定での資源変更前停止、秘密値の非出力、旧 Preview の挙動をテストする。最終 SHA で独立レビュー、clean checkout の高速検査、全テスト、build、ブラウザ QA、GitHub CI と正式 Preview を確認する。

信頼済み `main` への導入と期限付き資格情報の登録は、それぞれ承認を得た後に行う。復旧構成で Actions の診断を再実行し、ストア取得と後続の Neon 照合を確認する。AC-03 の実環境試験は診断後に続ける。
