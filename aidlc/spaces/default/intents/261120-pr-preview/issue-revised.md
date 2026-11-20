## 目的・背景

mille の PR を作成したら、Cake と同じように最新コミットを試せる Vercel Preview を自動で用意する。

## 対象範囲・対象外

- 同一リポジトリの `codex/*` から `main` への draft を含む PR を対象に、作成・更新・再オープンを GitHub Actions で処理する。PR イベントの受付と、管理用資格情報を扱う `main` 上の処理を分ける。
- PR ごとに Vercel Preview と mille 専用の Neon DB を用意する。DB に必要な migration を適用して架空 A/B を登録する。同じ PR の更新では DB を引き継ぎ、マージ・クローズ時に所有を照合できた PR 専用リソースを削除する。
- 既存の Vercel `mille`、GitHub `tyask/mille`、Neon `mille-preview` を再利用する。Vercel の通常の Git 自動デプロイを制御して PR Preview の起動を `main` の管理ジョブに限定する。既存の Neon 連携で Preview の自動分岐を確認し、必要なら設定する。
- 常設 Preview の URL と DB を維持する。Vercel の Preview 共通変数にある常設 DB の接続情報は常設用に限定し、PR デプロイへの引き継ぎを防ぐ。変更前に現在の設定、切替手順、復旧方法を照合する。URL と DB の維持または接続情報の分離を確認できない場合は切替を停止する。
- 対象外はアプリ機能、本番のデプロイ設定、Cake の資源・データの流用、新規 Vercel・Neon プロジェクトの作成。導入 PR のマージ、追加課金、永続資格情報の発行、権限拡大には別途承認を得る。

## 受入条件

- [ ] AC-01: 対象 PR の作成・更新・再オープンで、現在の HEAD の Preview URL が得られる。PR がないブランチへの push、fork、対象外ブランチは処理しない。
- [ ] AC-02: PR 間で DB が分離され、同じ PR の更新でデータを維持する。対象と所有権を照合し、対象 PR のマージ・クローズ時に専用リソースだけを削除する。
- [ ] AC-03: 管理用資格情報を `main` の管理処理に限定する。PR と HEAD または資源の所有権を照合できない場合は停止する。有効化前に利用枠と必要な権限を確認する。
- [ ] AC-04: 開発手順に Preview URL の確認と Ready 条件を記載する。現在の HEAD の CI と、正式 Preview 上の PC・スマホ × A/B ログインを確認する。
- [ ] AC-05: 導入 PR でレビュー、CI、起動条件・異常時の回帰検証を行う。導入後の確認用 draft PR で自動作成・更新・削除を実測し、結果を記録する。

- [ ] AC-06: 常設 Preview の URL と DB が切替前後で一致し、常設 DB の接続情報が PR デプロイに渡らない。通常のブランチ push では PR Preview を作らず、管理ジョブから起動した Preview が所有を照合済みの PR 専用子ブランチに接続することを確認する。

## 関連記録

- [Cake の PR Preview・QA 手順](https://github.com/tyask/Cake/blob/main/docs/development-workflow.md#3-自動previewとdb書込)
- [Cake の Actions 設計](https://github.com/tyask/Cake/blob/main/docs/actions-event-migration.md)
- [mille の開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)

- [導入 draft PR #19](https://github.com/tyask/mille/pull/19)
- [Neon の Vercel 連携と自動分岐](https://neon.com/docs/guides/vercel-managed-integration#enable-automated-preview-branching-recommended)

## 進捗

- チャットで提示した計画への承認「お願いします」を取得。
- 2026-11-20 JST に GitHub に保存した Issue 本文を提示し、計画承認とは別に「お願いします」と承認を得た。
- 2026-11-20 JST に Cake の PR イベント受付・Preview 管理ワークフローと、mille の既存 Preview DB 初期化手順を確認した。既存の Cloud checkout `/workspace/mille` の起動確認に進んだ。
- Cloud 実行環境の起動がタイムアウトした（`managed environment readiness timed out`）。既存 checkout にアクセスできず、Git の状態確認と実装は未着手。計画と保存済み Issue 本文への承認は取得済み。
- 起動後に導入 draft PR #19 を作成し、初回案の独立レビュー・ローカル検証・GitHub CI が完了した。正式 Preview は未検証。
- Vercel の既存 `mille` を `tyask/mille` に連携したことを確認。Preview 共通の環境変数に常設 DB 接続設定があり、Neon の Preview 自動分岐は未確認。
- 既存の常設 Preview の URL と DB の維持を条件に、常設用接続情報の分離、Git 自動デプロイの制御、既存 Neon の自動分岐確認・必要な設定を計画へ含めることについて、チャットで「お願い」と承認を得た。保存後の変更版 Issue 本文への承認は別途確認する。
