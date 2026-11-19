## 目的・背景

mainの依存監査に残っている `GHSA-g3hv-75wg-m249` を解消する。監査のmoderate 7件は、ESLintの `typescript-eslint` 経由で入った `minimatch 10.2.6` と、それに依存するパッケージの集計である。

## 対象範囲・対象外

- 最新mainを起点にdraft PRを作る。 `typescript-eslint` 系を `eslint-config-next 16.4.6` の宣言範囲内で更新する。候補の `8.73.0` は `minimatch ^11.0.1` を使用し、公開アドバイザリの修正版を解決できる。
- Node 24.22.3のnpmで既存 `package-lock.json` を入力にし、 `npm update typescript-eslint --package-lock-only --ignore-scripts --no-audit --no-fund` などの対象を限定した方法で再生成する。直接依存の指定を変えず、npmが解決した差分を確認する。
- Cloudで実行できない場合、PRブランチの一時的な読み取り専用Actionsジョブで生成する。公開npmレジストリのlockfileと検証用ハッシュを照合し、最終HEADから一時ジョブを削除する。
- 変更は `package-lock.json` と作業記録が対象。Node.js・Next.jsその他の直接依存の変更、アプリの変更、広範な依存更新、Vercel設定・本番操作、マージは対象外。

## 受入条件

- [ ] AC-01: 生成済みlockfileに影響範囲のminimatchが残らず、直接依存・overrides・Nodeの指定が同一。変更は対象の開発用依存経路に限る。
- [ ] AC-02: 最終HEADの依存監査で `GHSA-g3hv-75wg-m249` が報告されず、監査結果をPRに記録する。その他の指摘があれば区別する。
- [ ] AC-03: 一時生成設定が最終差分に含まれず、最終SHAのCIで依存導入・lint・型検査・テスト・build・ブラウザQAが通る。別Agentの読み取りレビュー結果をPRに記録する。

## 関連記録

- [現在のmainの監査ログ](https://github.com/tyask/mille/actions/runs/44561747725/job/135692597417)
- [minimatchのアドバイザリ](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [typescript-eslint 8.73.0の依存宣言](https://github.com/typescript-eslint/typescript-eslint/blob/v8.73.0/packages/typescript-estree/package.json)

## 進捗

- 利用者から「それも更新してください」と、残るminimatch指摘に対応する更新の指示を取得。
- 保存済みIssue本文への承認後に作業を開始する。
