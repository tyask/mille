# ワークスペース実装計画

## 目的と承認済み範囲
既存ログイン基盤58f7fbd1ef80c482ffd1b5c27c2cab11ccf8309fに、献立アプリMilleの個人用・共有用ワークスペースを追加する。
共有用に人数の固定上限は設けない。個人用は本人のみ。
承認済みIssue: https://github.com/tyask/mille/issues/3

## 実装
1. 既存app_users・Auth.js・有効状態再確認・環境識別を再利用する。001_auth.sqlは変更しない。
2. 002_workspaces.sqlでworkspaces・workspace_members・招待を追加する。認証済み利用者のID/メール/有効状態と所属をDB処理でも確認する。
3. Neon HTTPとCloud PGliteは単一問い合わせ単位のため、初期作成・招待発行/参加・変更/削除をSQL関数内で原子的に実行する。競合には行ロックと一意制約を使う。
4. migration管理を複数原文・hash照合・未適用分へ拡張し、既存DBから更新する。Cloudと生成済み初期化SQLにも同じmigrationを反映する。
5. 型・入力schema・用途別service・Route Handlerを追加する。所属外情報を返さず、応答はprivate/no-store、更新は同一originを検証する。
6. 既存ブランドのPC/スマホUIに作成・一覧・切替・参加者・名称変更・名称一致確認付き削除・メール宛招待・本人宛招待一覧を追加する。ログイン時の招待戻り先を維持する。
7. 共有人数はすべて可変配列で扱う。個人用以外に人数上限・家計の負担割合は持ち込まない。

## 検証と受入
IssueのAC-01〜AC-09を正本とする。
- 単体/DB: 旧001からの更新、hash・環境guard、個人分離、初期作成競合、所属外拒否、名前確認、cascade。
- 招待: 7日間、宛先正規化、本人/既存参加者拒否、hashのみ保存、再発行旧token失効、他メール/期限切れ拒否、原子的参加・重複防止。
- 人数: CloudのA/B seedを維持し、単体PGliteだけに架空C/Dを追加して3人以上・同時参加の成立を検証する。
- 認証: 既存回帰を維持し、停止後の拒否、Productionのテスト認証禁止、Previewの本番fallback禁止を確認する。
- ブラウザ: PC/mobile × A/B、個人用分離、共有作成→招待→参加→両者表示、選択復元、名称変更/削除、未認証/所属外拒否。
- Node版・lint・型・test・build、自己レビュー、記録凍結、commit、独立Agentレビュー、最終SHAのclean checkoutで再検証。
- draft PRを作り現在HEADのCI・既存専用Previewを照合する。実Google OAuthとローカルA/B結果を区別し、未確認があればdraftを維持する。

## 外部操作の境界
Production反映・merge・課金・永続資格情報発行・権限拡大は行わない。
既存の専用Previewは対象project/DB/host/markerを確認して使用する。CakeのDB・利用者・資格情報は流用しない。
