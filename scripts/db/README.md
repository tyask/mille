# 専用DBの初期化と利用者管理

秘密値は安全な環境設定から渡す。接続 URL を引数・ログ・Git へ書かない。
操作前に承認済み Neon account/project/branch/database と接続先ホストを照合する。
SQL 自体では provider 上の project 所有権や接続ホストを証明できない。

## 正規コネクタで SQL を適用する場合

1. Mille 専用の空DBであること、Production と Preview が異なる対象であることを照合する。
2. Preview は `initialize-preview.sql`、Production は `initialize-production.sql` の原文を適用する。
3. 次の読み取りで期待する環境・履歴を確認する。
4. Preview にだけ `seed-preview.sql` を適用する。Production には seed を適用しない。
5. Preview は利用者が架空 A/B のみであることを読み取り確認する。

```sql
SELECT project, environment, environment_id FROM mille_environment;
SELECT name, sha256 FROM schema_migrations;
-- Preview 専用。実利用者の一覧をログやチャットへ出さない。
SELECT id, email, is_enabled, is_test FROM app_users WHERE is_test = true;
```

環境識別は Production が `tyask/mille / production / mille-production`、
Preview が `tyask/mille / preview / mille-preview`。
初期化は別用途の既存テーブルがあるDBを拒否する。同一環境・同一 SQL hash の再適用は無変更。
seed は同一IDの別メール等の衝突を拒否し、既存の停止状態や表示名を上書きしない。

SQL 原本は `db/migrations/` の連番ファイル。`001_auth.sql` は認証、`002_workspaces.sql` はワークスペース・所属・招待を定義する。
standalone SQL は `node --import tsx scripts/db/generate-sql.ts` で生成する。
適用後の原本は編集せず新 migration を追加する。migration は専用DBの識別と適用済み原文 hash を確認し、
advisory transaction lock の下で未適用分だけを番号順に適用する。SQL と履歴は一括で確定する。
未知の適用履歴や hash の不一致は拒否し、既存利用者・停止状態・環境 marker を保持する。
生成物と原本の一致、認証だけを適用済みのDBからの更新は回帰テストで確認する。

既存の Mille DB を更新するときは対象照合後に `db:setup` を `--initialize` なしで実行する。
Cloud の使い捨て PGlite も同じ migration を使い、seed は架空 A/B のみを登録する。
build や通常のアプリ起動は hosted DB の migration・seed を実行しない。

ワークスペースの操作は `mille_workspace_command` の1回の呼び出し内で、現在有効な内部ID・メール・所属を確認する。
初期の個人用作成は利用者行、招待の再発行・参加・削除はワークスペース行をロックして原子的に処理する。
個人用は作成者本人のみ、共有用の参加人数には固定上限を設けない。
招待リンクは7日間有効で、DBにはトークンの SHA-256 のみを保存する。同じ宛先への再発行は旧リンクを無効にする。
通常の一覧にトークンや hash は含めない。利用者の事前登録・有効状態の条件は招待でも変更しない。

## CLI を使う場合

Preview は `MILLE_PREVIEW_DATABASE_URL`、Production は `DATABASE_URL` を設定する。
次の `<host>` は承認済み接続先の正確な hostname を指定する。実URLやpasswordを置かない。

```bash
npm run db:setup -- --environment preview --expect-host <host> --environment-id mille-preview --initialize
npm run db:seed:test -- --environment preview --expect-host <host> --environment-id mille-preview
```

Production は対象を個別確認してから `--environment production --environment-id mille-production` で初期化する。
本人指定後の実利用者登録・無効化も、明示した対象だけを操作する。

```bash
npm run user:register -- --environment production --expect-host <host> --environment-id mille-production --email <approved-email> --name <display-name>
npm run user:disable -- --environment production --expect-host <host> --environment-id mille-production --user-id <internal-id>
```

登録は既存の停止状態を自動解除しない。ユーザーの自動登録、管理画面、Cake の固定ユーザーは存在しない。
