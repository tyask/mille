## 目的・背景

mille の PR では専用 Preview の URL が Actions の Summary に出る。Cake と同じ4列の表とチェック欄から、mille の PR でも最新コミットの Preview URL と作成状況を確認できるようにする。

## 対象範囲・対象外

- GitHub Actions Bot が PR ごとに1件のコメントを作成・更新し、`Project | Deployment | Actions | Updated` の表を表示する。Ready 時はデプロイ詳細と保護付き Preview URL、作成中・失敗時は該当の Actions 実行へ案内する。
- 現在のコミットに `mille / Preview` ステータスを付ける。PR コメントとコミットステータスの書き込み権限は、Vercel・Neon の資格情報を持たない `main` の通知ジョブに限定する。
- 対象外は Vercel Bot への切替、デプロイや専用 DB の作成・削除方式の変更、Preview の認証設定やマージ条件の変更。

## 受入条件

- [ ] AC-01: 対象 PR の会話欄に4列の表が1件表示され、チェック欄に現在のコミットの Preview ステータスが表示される。
- [ ] AC-02: 現在のコミットのデプロイが `READY` と照合できた場合に Ready と Preview URL が表示される。作成中・失敗時は該当の Actions 実行へ移動できる。
- [ ] AC-03: 追加 push と再実行で同じコメントが更新される。古いコミットの実行は最新の表示を上書きせず、対象外 PR や利用者のコメントは編集されない。
- [ ] AC-04: 状態の表示、リンク先、コメント更新、古い実行の扱いを回帰テストで確認する。実運用で有効になった後は確認用の draft PR で表とチェックを照合する。

## 関連記録

- [Cake の通知例](https://github.com/tyask/Cake/pull/181#issuecomment-7014395343)
- [mille の Preview 作成例](https://github.com/tyask/mille/actions/runs/44852712885)
- [mille の Preview 運用手順](https://github.com/tyask/mille/blob/main/docs/pr-preview.md)

## 進捗

- チャットで提示した計画への承認を受領。保存した Issue 本文への承認後に実装を開始する。