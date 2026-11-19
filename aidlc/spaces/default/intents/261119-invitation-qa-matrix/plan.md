# 招待ログインQAの診断計画

## 目的

同じmainコミットがUbuntu 24.04で成功、Ubuntu 26.04で招待ログインQAに失敗した。別の診断用draft PRに同条件のrunner比較と操作単位の診断を置き、失敗箇所を特定する。

## 実装と検証

1. 最新mainの完全SHAから専用ブランチを作成する。
2. `scripts/cloud/verify.ts` に招待ログインの7操作の固定名、操作と全体の経過時間、エラー種別、同一originにおける限定routeのHTTPステータスを記録する。招待routeは定数へ置換する。
3. `.github/workflows/ci.yml` でUbuntu 24.04と26.04の両方を使用し、片側失敗時も他方を実行する。checkout HEAD、検証コマンド、既存の操作・アサーション、Node・依存指定を維持する。artifact名をOSごとに分ける。
4. 診断範囲、承認、静的確認を凍結し、別Agentが完全SHAと基準の差分を読み取りレビューする。
5. 診断用draft PRの両jobを完了まで確認し、imageとHEAD、合否、診断結果をPRとIssueへ記録する。

診断PRではPGliteと既存の架空テスト利用者だけを使用する。Vercel、認証・アプリ・DB、依存、main、PR #8の差分はこの実験の対象外。
