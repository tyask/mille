# Mille の開発ルール

Cake の開発手順を踏襲する。Issue・PR・記録・報告は日本語で書く。

## 承認と完了条件

1. 読み取り調査後、目的・範囲・受入条件・実装と検証方法をチャットへ提示する。
2. 提示した計画への利用者承認後に Issue を作成・更新する。
3. GitHub に保存された Issue 本文を再取得して本文と URL を提示し、別の承認を受ける。
4. 両承認後に開発ブランチを作成し、`aidlc/` に計画と別々の承認証拠を保存して実装する。
5. 関連テスト・自己レビュー後に記録を凍結して commit する。
6. 別 Agent が新しい文脈で要求・適用ルール・比較元・完全 SHA を受け取り、読み取り専用でレビューする。
7. 最終 SHA の clean な checkout で lint・型検査・テスト・build・必要なブラウザ QA を確認する。
8. draft PR を作成し、現在 HEAD の CI・正式 Preview・必要な検証を揃えて Ready と結果を報告する。

計画承認を Issue 承認へ流用しない。両承認がある同一範囲では再承認を求めない。
利用者が調査のみ等を指定した場合は優先する。範囲変更は計画・Issue を更新して承認する。
PR merge、Production 操作、新規課金、永続資格情報の発行、アクセス権拡大は別途明示承認が必要。
不可能な検証を成功扱いせず、draft を維持して具体的な阻害要因を報告する。
Issue は `目的・背景`、`対象範囲・対象外`、`受入条件`、`関連記録`、`進捗` の独立見出しと
`- [ ] AC-01: ...` 形式を使う。Intent は `aidlc/spaces/default/intents/` に保存する。
凍結後の結果は PR／Issue に記録する。追跡ファイルを変更した場合は新 SHA で再レビューする。

## 実行環境と検証

正本は `.node-version`。[開発手順](docs/development.md) を先に読む。
Cloud は隔離済みなので既存 checkout を使い、明示依頼なしに重複 worktree を作らない。
作業開始時は status・branch・HEAD を確認し、`npm run task:start -- new codex/<name>` または
`npm run task:start -- continue <expectedbranch>` を実行する。計画と保存済み Issue の両承認前は
`continue` による調査・状態報告までとし、新規ブランチ作成や実装へ進まない。
新規作業は clean かつ現在 HEAD が fetch 済み `origin/main` の祖先である場合に限り、
その最新 SHA から既存 checkout に新しいブランチを作る。local main・旧ブランチ・ignored ファイルを保持する。
継続は期待ブランチとの一致を必須にし、Git の変更は fetch のみにする。dirty・未公開コミット・
main や自身の remote branch との差分を報告し、自動 pull / reset / stash / rebase をしない。
fetch 失敗時は最新性を確認済みと扱わない。CLI の終了コードは `0` が確認条件成立、`2` が要対応、
`1` が失敗・拒否。`0` は実装承認やアプリ動作検証を代替しない。
依存導入記録が unknown / stale なら、両承認後に `npm run deps:sync` で `npm ci` による再導入を行い、
同じブランチを `continue` で再確認する。`new` がブランチを作成済みなら、依存不足でも保持し、同名の `new` を繰り返さない。
`deps:sync` は Chromium を取得しない。`setup:cloud` は依存・Chromium の準備だけを行い、Git を同期しない。
Cloud のバックグラウンド repository refresh と、既存タスクの状態保持・開始時点の最新性確認を区別する。
Cloud 起動指示の適用用本文と設定反映手順は [cloud-start-skill.md](docs/cloud-start-skill.md) を参照する。
ローカルは `dev:cloud` / `qa:cloud` で PGlite と架空 A/B のみを使う。Cake の DB・実利用者・資格情報を流用しない。
ローカル QA、正式 Neon／Vercel Preview、実 Google OAuth の結果を区別する。

## 認証・DB・外部資源

Google の確認済みメール、事前登録、有効状態、内部 ID を確認し、自動登録しない。
保護画面・API は毎回 DB で現在の利用可否を再確認し、利用者別応答を共有キャッシュしない。
Production は設定ミスでもテスト認証・テスト用 ID・seed を拒否する。
Preview は専用接続変数と所有権 marker を必須にし、本番への fallback を作らない。
migration・登録・無効化・seed の前に対象 project／DB／host／環境を照合する。適用済 SQL は変更しない。
秘密値を Git・チャット・引数・ログ・artifact に出さない。正規ツールを使用し、通信拒否・TLS検証を回避しない。
将来の健康・栄養・献立データにはサーバー側の所属・権限確認を必須とし、共有機能を先行作成しない。
