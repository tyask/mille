# Cloud 起動指示

[Issue #5](https://github.com/tyask/mille/issues/5) の `start_skill` 適用用本文と反映手順。
この変更では公開環境の起動指示を変更していない。現在読めるのは旧ドラフト revision 2 であり、
最新の公開設定とは断定できない。以下は適用用本文として保存し、旧ドラフトへの上書き・保存・公開は行わない。

## start_skill へ統合する本文

### 1. 既存 checkout と作業許可を確認する

`/workspace/mille` の既存 checkout を使う。Cloud タスクは既に隔離されているので、
利用者の明示依頼なしに Git worktree や置換タスクを作らない。最初に `AGENTS.md` と
`docs/development.md` を読み、次を確認する。

```bash
cd /workspace/mille
git status --short
git branch --show-current
git rev-parse HEAD
```

Node は `.node-version` の完全なバージョンに合わせる。既存ファイル・ブランチ・ignored ファイル・
未公開コミットを保持し、資格情報や環境変数の値を表示しない。
計画と GitHub に保存済みの Issue 本文への別々の承認を確認する。同一範囲の承認済み作業に再承認を要求しない。
両承認前は調査と `continue` の確認・報告に留め、新規ブランチ作成・実装・依存再導入・サービス起動へ進まない。

### 2. new / continue を選ぶ

両承認がある新規作業なら `npm run task:start -- new codex/<name>` を使う。
`<name>` は承認された作業名に置き換える。clean で、現在 HEAD が fetch した `origin/main` の祖先である場合だけ、
最新 main の SHA から既存 checkout に新しいブランチを作る。local main と既存ブランチは動かさない。
開始元は main に限らず、main に取り込まれた旧 feature branch でも祖先条件を満たせばよい。
切替先の追跡ファイルと ignored ファイルが衝突する場合は上書きせず拒否する。

継続なら `npm run task:start -- continue <expectedbranch>` を使い、期待ブランチ名を明示する。
現在ブランチとの不一致を許容しない。意図や期待ブランチが不明なら現在ブランチを確認用に指定し、`continue` による確認・報告のみを行い、
編集を止める。現在ブランチを確認用に使っただけで、作業継続が承認されたとは扱わない。
現在ブランチ不明・detached HEAD・承認範囲不明なら状態を報告して止める。

`continue` の Git 変更は fetch のみ。dirty・未公開コミット・main や自身の remote branch との
遅れ・先行・分岐を報告し、pull / reset / stash / rebase を自動実行しない。
最新 main を含み、自身の remote branch と一致する公開済み feature branch は、main より先行していても継続できる。
main への遅れ、自身の remote との差、dirty、未公開コミット、依存状態が unknown / stale の場合は要対応として扱う。

### 3. fetch と基準 SHA、差分を確認する

保存された古い checkout に `task:start` 自体がない場合は、そのまま旧コードで作業を始めない。
origin が `github.com/tyask/mille` であることを URL の資格情報を表示せず確認し、
次の読み取り・remote ref 更新で最新の手順を調べる。

```bash
git fetch --prune --no-tags --no-prune-tags --no-recurse-submodules origin '+refs/heads/*:refs/remotes/origin/*'
git rev-parse refs/remotes/origin/main
git log --oneline HEAD..origin/main
git diff --stat HEAD origin/main
git show origin/main:AGENTS.md
```

fetch の失敗を無視せず、成功したときだけ後続を実行する。最新 main の手順も確認できない場合は停止する。
継続作業のファイルを最新 main で上書きしない。新規作業では両承認、clean、現在 HEAD が取得済み main の祖先、
新しいブランチ名の未使用を照合できた場合に限り、`git switch --no-overwrite-ignore --no-track -c codex/<name> <取得した完全SHA>`
で同じ checkout に作成し、最新の `task:start -- continue` で再確認する。
この手動復旧も local main・旧ブランチ・ignored ファイルを保持する。判断できない場合は自動復旧せず報告する。

CLI の結果 JSON と実際の終了コードを確認する。fetch 成功、作業ブランチ、HEAD、
基準となる `origin/main` の完全 SHA、差分、依存の状態を報告する。
`new` ではブランチ作成結果も確認する。SHA の違いだけで内容が古いとは断定しない。
fetch が失敗したら古い参照を最新と扱わず、原因・阻害要因を報告して止める。

- `0`: CLI の確認条件成立。実装承認やアプリの動作保証ではない。
- `2`: 要対応で ready ではない。JSON で状態を確認して対処する。
- `1`: 失敗・拒否。原因を確認し、同じ条件のまま繰り返さない。

Cloud の公式バックグラウンド repository refresh と、この開始時点の確認は別である。
既存タスクの作業状態保持から、最新 main への同期済みや最新公開版への自動移行を推定しない。

### 4. 必要な依存だけを再導入して再確認する

両承認後、`node_modules/.mille-dependencies.json` の依存導入記録が `unknown` / `stale` なら、
同じ checkout で `npm run deps:sync` を行う。
これは `npm ci` による再導入と記録を行い、Chromium を取得しない。
`node_modules` の存在だけで依存一致を判断しない。
成功後は `npm run task:start -- continue <expectedbranch>` で現在ブランチを再確認する。
依存以外の要対応事項も結果から確認し、未解決なら ready と報告しない。

`new` がブランチを作成済みで依存不足を報告していても、そのブランチを保持する。
同名 `new` を繰り返さず、`deps:sync` と `continue` を使う。
ブラウザが必要で未導入なら `npm run setup:cloud` で依存と公式 Playwright Chromium を準備する。
`setup:cloud` は Git の fetch・同期・ブランチ作成を行わない。
proxy・CA・TLS 検証を維持し、配布先への拒否はサポートされる環境設定で解消する。

### 5. 必要なサービスを起動し、応答を確認する

現在の依頼が必要とする場合に、`/workspace/mille` で `npm run dev:cloud` を起動する。
PGlite と架空 A/B を使い、Cake や正式環境の DB・利用者・資格情報を流用しない。
既存の `.env` 系ファイルで起動が拒否された場合は保持し、勝手に削除・移動しない。

HTTP 200 のログイン画面に架空 A/B の選択肢があり、未認証の `/api/me` が HTTP 401 を返すことを確認する。
必要なブラウザ QA は `npm run qa:cloud` で PC/mobile × A/B を検証し、今回の結果を確認する。
この QA は自分で一時サーバーと DB を起動して終了するため、既に使っている port と重複させない。
例えば開発サーバーが 3000 を使用中なら `npm run qa:cloud -- --port 3001` を使う。
PID や port だけで起動成功と扱わず、ローカル結果と正式 Preview・実 Google OAuth を区別する。
新しい環境で以前のプロセスが存続しているとは仮定せず、自分が起動したサービスだけを停止する。

## 公開設定へ反映するときの手順

1. 対象が Mille であることを照合し、最新の公開設定を実際に読む。旧タスクに結び付いたドラフトを
   最新の公開設定として扱わない。最新版を読めなければ、本文準備までで止めて制約を報告する。
2. 最新設定の既存 `start_skill` を読み、必要な既存指示を保持して上の本文を調整・統合する。
   `install_script`、repository、ネットワーク、secret、環境変数、その他の設定は保持する。
   古いドラフトの値から最新設定全体を置き換えない。
3. 保存・公開はサポートされる UI の操作で行う。利用可能な操作がなければ適用用本文だけを提供し、
   公開済みと報告しない。保存済みドラフト、公開版、稼働中タスクの起動元バージョンを区別する。
4. 公開後の新規タスクで、checkout・branch・完全 SHA、fetch 成否、最新 `origin/main` との比較、
   依存状態と必要なサービスの応答を別途検証する。この検証は公開操作とは別の証拠として残す。
   既存タスクが最新公開版へ自動移行したとは主張しない。現在のタスクを勝手に置換しない。

本件はアプリ機能、認証、DB migration、Vercel / Neon の設定、Issue #3 / PR #4 のワークスペース機能を変更しない。
