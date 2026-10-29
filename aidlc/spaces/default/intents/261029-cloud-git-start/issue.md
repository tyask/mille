## 目的・背景
Mille Cloud で作業開始時に古い Git 参照を使う問題を防ぐ。Cake の明示的な fetch・最新 origin/main を基準にした開始手順を参考に、Mille の隔離済み checkout に適した安全な確認を追加する。

診断時の既存タスクでは HEAD acca857、local main / origin/main 9625546、remote main 58f7fbd だった。ただし HEAD と remote main の tree は一致しており、SHA 差だけでは内容が古いとは判定しない。Cloud の公式仕様にはバックグラウンド repository refresh があるが、既存タスクの作業状態を保持することと、作業開始時の最新性確認は区別する。旧タスクの設定ドラフトだけから最新公開設定を断定しない。

## 対象範囲・対象外
### 対象
- AGENTS.md・開発ドキュメント・必要最小限の開始処理に、status / branch / HEAD / remote の確認、fetch、最新 origin/main との比較を定義する。
- 新規作業は承認された最新 origin/main を基点に開始し、基準 SHA を記録する。Cloud は既存 checkout を使い、不要な重複 worktree を作らない。
- 継続作業では未コミット変更、未公開コミット、既存ブランチ・PR を保護する。自動 pull / reset / rebase / stash をせず、差分や分岐があれば状態と必要な判断を報告する。
- fetch 失敗や権限拒否時は古い情報を最新と扱わず、安全に停止・報告する。
- 依存定義・lockfile の差分があれば npm ci 等の必要な再導入を行う手順を定義する。
- Cloud start skill に同じ開始確認を反映できるよう、設定用の指示文と手順を準備する。実際の最新設定を確認し、他のネットワーク・秘密情報・設定を保持する。直接更新・公開できない場合はその制約と利用者操作を明記する。
- 正常・古い main・dirty・未公開コミット・分岐・fetch 失敗・継続ブランチを隔離したテストで確認し、自己レビュー・独立レビュー・CI・PRを行う。

### 対象外
- アプリ機能、認証、DB migration、Vercel / Neon、本番・Preview の配置変更。
- Cake リポジトリや作業中のワークスペース機能（Issue #3 / PR #4）への変更。
- 作業中データを捨てる Git 操作、資格情報発行、ネットワーク権限の拡大、別の置換 Cloud タスクの作成。
- PR merge。Cloud 設定の公開操作が未対応なら完了したと扱わない。

## 受入条件
- [ ] AC-01: 新規作業の開始前に remote の最新 main を取得・照合し、基準 SHA が分かる。
- [ ] AC-02: dirty / 未公開コミット / 継続ブランチ / 分岐で作業内容を破壊しない。
- [ ] AC-03: fetch 失敗を検知し、古い参照で最新確認済みと誤報告しない。
- [ ] AC-04: 継続タスクと新規タスクの扱い、依存変更時の再導入を説明・検証する。
- [ ] AC-05: repo の手順と Cloud 起動指示が整合する。公開環境への反映状態と既存タスクへの適用限界を区別して報告する。
- [ ] AC-06: 隔離 Git fixture で回帰検証し、既存アプリの lint / typecheck / test / build と CI が成功する。最終 SHA を確認し、レビュー後 Ready にする。

## 関連記録
- Mille: https://github.com/tyask/mille
- Cake: https://github.com/tyask/Cake/blob/f4202fcfb34169a10be5d9c84564a64206a9893f/scripts/task/start-task.ts#L88-L102
- 公式: https://learn.chatgpt.com/docs/environments/cloud-environments#reuse-and-update-saved-state
- 初期構築 PR #2 は merge 済み。本件は独立した開発手順の改善。

## 進捗
- 読み取り診断完了。2026-10-29 に利用者が改善方針へ「お願いします」と回答し、計画承認済み。
- 保存済みの本 Issue 本文に対する別途承認待ち。実装・設定変更・開発ブランチ作成は未実施。
