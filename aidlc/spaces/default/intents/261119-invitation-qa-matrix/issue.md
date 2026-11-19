## 目的・背景

招待リンク経由のログインがGitHub ActionsのブラウザQAで失敗する原因を切り分ける。PR #8の2回の実行と、文書差分のない同一main SHAの再実行はUbuntu 26.04で同じ工程 `workspace-invitation-login` に失敗した。同一main SHAの以前の実行はUbuntu 24.04で成功した。現行ログには操作単位の失敗情報がない。

## 対象範囲・対象外

- 現在のmainから診断用draft PRを作る。`scripts/cloud/verify.ts` の招待ログインを操作ごとに識別し、失敗した操作名、経過時間、エラーの固定分類、許可したHTTPステータスを記録する。
- 診断用PRの `.github/workflows/ci.yml` で、同じコミットを `ubuntu-24.04` と `ubuntu-26.04` で実行する。Node・依存関係・既存のテスト操作と合否判定は揃える。
- QAは既存のPGliteと架空テスト利用者で行う。招待の実URL、トークン、資格情報、例外本文は出力しない。
- アプリの挙動、認証、DB、依存パッケージ、Vercel設定、main、PR #8の差分の変更とマージは対象外。実験結果は診断PRとIssueに残す。

## 受入条件

- [ ] AC-01: 同一SHAのCIを両Ubuntuで実行し、実際のランナー画像とQAの合否を確認する。
- [ ] AC-02: 失敗時は、招待の実URLやトークンを記録せず、止まった操作・経過時間・エラー種別・取得できたHTTPステータスを確認できる。
- [ ] AC-03: 両環境の結果を比較し、特定できた原因と残る不確実性を記録する。両方とも通過した場合は、再現しなかった条件と今回の観測値を記録する。

## 関連記録

- [PR #8](https://github.com/tyask/mille/pull/8)
- [基準mainの初回・Ubuntu 24.04](https://github.com/tyask/mille/actions/runs/40898159684/attempts/1)
- [同じmainの再実行・Ubuntu 26.04](https://github.com/tyask/mille/actions/runs/40898159684/attempts/2)
- [GitHubのUbuntu移行案内](https://github.com/actions/runner-images/issues/14748)

## 進捗

- 利用者から「了解です。別PRで検証してください。」と診断方針への承認を取得。
- 保存済みIssue本文への別承認後に、診断ブランチとdraft PRを作成する。
