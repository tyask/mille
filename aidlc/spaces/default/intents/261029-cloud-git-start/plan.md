# Cloud 作業開始時の Git 最新化確認

保存済み Issue #5 を正本とする。アプリ・認証・DB・provider・配置・並行中のワークスペース実装は変更しない。

1. 既存変更と未公開コミットを確認し、明示 refspec で取得した最新 `origin/main` の完全 SHA から、この checkout に専用ブランチを作る。
2. Node 組込 API の開始処理を追加する。対象 remote、Git root、操作中状態、branch、HEAD、dirty を照合し、fetch 失敗では停止する。
3. 新規は clean かつ現在 HEAD が最新 main の祖先である場合のみ、最新 SHA から新規 branch を作る。継続は branch 一致を要求し、fetch 以外の Git 変更をしない。差分・分岐・未公開 commit を報告する。
4. 成功した `npm ci` と依存定義・lockfile・Node/platform の fingerprint を対応付け、未記録・変更を検出する。依存の再導入を Chromium 導入と分離する。
5. AGENTS・開発手順・適用用 Cloud start skill を整合させる。旧ドラフトしか確認できないため Cloud 設定を上書きせず、未反映と記録する。
6. 隔離 Git fixture と依存 fixture、既存テスト、lint、型検査、build、自己レビュー・独立レビュー、最終 SHA の CI で検証する。

`pull` / `reset` / `rebase` / `stash`、worktree 新設、利用者データ削除、PR merge は実装しない。承認済み Issue の古い「別途承認待ち」記載は原文 snapshot として保持し、実際の承認は approvals.json に記録する。
