# Neon Native Preview の停止箇所を診断する

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-03 で、試験 A のデプロイと両 PR の削除ジョブが停止した確認項目を識別できるようにする。

信頼済み `main` から手動実行する読み取り専用診断を追加する。管理ジョブと同じ GitHub Environment `mille-pr-preview` の既存資格情報で、復旧済みの Vercel と Neon の状態を照合する。診断出力は確認項目と取得できた HTTP 状態に限定する。

想定した失敗箇所を識別できること、秘密値や API 応答本文が出ないこと、資源の作成・削除や DB 初期化が発生しないことをテストする。既存動作のテスト、最終 SHA の Cloud 検証、GitHub CI と正式 Preview を確認する。

停止原因の特定・対応と、新しい試験 PR での分離、更新後のデータ保持、クローズ・マージ後の削除は、この診断の導入後に行う。
