## 目的・背景

招待ログインQAが、招待リンクに進む前のログアウトクリックで止まる問題を直す。診断用PR #10で、Ubuntu 24.04と26.04のどちらでもNext.jsの開発用インジケーターがクリック位置を覆い、30秒でタイムアウトすることを確認した。

## 対象範囲・対象外

- mainから修正用draft PRを作る。`qa:cloud` がローカルで起動するNext.js子プロセスに限って、`devIndicators: false` を設定する。通常の `dev:cloud` ではNext.js既定の表示設定を使用する。
- 対象は `next.config.ts`、`scripts/cloud/dev.ts`、`scripts/cloud/verify.ts` と作業記録。既存のログアウト・招待ログイン・参加の操作と判定、認証、DB、依存パッケージは変更しない。
- 同一修正をUbuntu 24.04・26.04で比較するため、修正ブランチのCIを一時的に2環境にする。比較結果を記録したあとCI設定を変更前へ戻し、修正PRの最終HEADで通常のCIも確認する。
- 文書PR #8と診断用PR #10の差分、Vercel設定と本番環境の変更、PRのマージは対象外。

## 受入条件

- [ ] AC-01: `qa:cloud` のローカル起動に限り開発用インジケーターが無効になり、通常起動は既定設定を維持する。
- [ ] AC-02: 同一修正コミットのUbuntu 24.04と26.04で `qa:cloud` が成功し、既存のログアウト・招待ログイン・参加を含む4ケースが通る。
- [ ] AC-03: 一時的なCI比較設定を取り除いた最終HEADで通常CIを確認し、比較と最終検証を別々のSHAでPRに記録する。

## 関連記録

- [診断用PR #10](https://github.com/tyask/mille/pull/10)
- [Ubuntu 24.04の診断ログ](https://github.com/tyask/mille/actions/runs/44547312256/job/135641232611)
- [Ubuntu 26.04の診断ログ](https://github.com/tyask/mille/actions/runs/44547312256/job/135641233235)
- [Next.jsの開発用インジケーター設定](https://github.com/vercel/next.js/blob/v16.4.3/docs/01-app/03-api-reference/05-config/01-next-config-js/devIndicators.mdx)

## 進捗

- 利用者の「修正を進めてください」を受け、上記の範囲で修正差分を準備した。
- 保存済みIssue本文への承認後、修正ブランチとdraft PRで実行する。
