## 目的・背景

mille の PR を作成したら、Cake と同じように最新コミットを試せる Vercel Preview を自動で用意する。

## 対象範囲・対象外

- 同一リポジトリの `codex/*` から `main` への draft を含む PR を対象に、作成・更新・再オープンを GitHub Actions で処理する。PR イベントの受付と、管理用資格情報を扱う `main` 上の処理を分ける。
- PR ごとに Vercel Preview と mille 専用の Neon DB を用意する。DB に必要な migration を適用して架空 A/B を登録する。同じ PR の更新では DB を引き継ぎ、マージ・クローズ時に所有を照合できた PR 専用リソースを削除する。
- 対象外はアプリ機能、本番・常設 Preview のデプロイ設定、Cake の資源・データの流用。導入 PR のマージ、追加課金、永続資格情報の発行、権限拡大には別途承認を得る。

## 受入条件

- [ ] AC-01: 対象 PR の作成・更新・再オープンで、現在の HEAD の Preview URL が得られる。PR がないブランチへの push、fork、対象外ブランチは処理しない。
- [ ] AC-02: PR 間で DB が分離され、同じ PR の更新でデータを維持する。対象と所有権を照合し、対象 PR のマージ・クローズ時に専用リソースだけを削除する。
- [ ] AC-03: 管理用資格情報を `main` の管理処理に限定する。PR と HEAD または資源の所有権を照合できない場合は停止する。有効化前に利用枠と必要な権限を確認する。
- [ ] AC-04: 開発手順に Preview URL の確認と Ready 条件を記載する。現在の HEAD の CI と、正式 Preview 上の PC・スマホ × A/B ログインを確認する。
- [ ] AC-05: 導入 PR でレビュー、CI、起動条件・異常時の回帰検証を行う。導入後の確認用 draft PR で自動作成・更新・削除を実測し、結果を記録する。

## 関連記録

- [Cake の PR Preview・QA 手順](https://github.com/tyask/Cake/blob/main/docs/development-workflow.md#3-自動previewとdb書込)
- [Cake の Actions 設計](https://github.com/tyask/Cake/blob/main/docs/actions-event-migration.md)
- [mille の開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)

## 進捗

- チャットで提示した計画への承認「お願いします」を取得。
- 2026-11-20 JST に GitHub に保存した Issue 本文を提示し、計画承認とは別に「お願いします」と承認を得た。
- 2026-11-20 JST に Cake の PR イベント受付・Preview 管理ワークフローと、mille の既存 Preview DB 初期化手順を確認した。既存の Cloud checkout `/workspace/mille` の起動確認に進んだ。
- Cloud 実行環境の起動がタイムアウトした（`managed environment readiness timed out`）。既存 checkout にアクセスできず、Git の状態確認と実装は未着手。計画と保存済み Issue 本文への承認は取得済み。
