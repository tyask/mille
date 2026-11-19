## 目的・背景

Node.js 24系のセキュリティ修正と、Next.js 16.4.3に対する依存監査指摘の修正版を取り込む。影響を切り分けるため、Node.jsの更新を先に検証してから、Next.jsを別PRで更新する。

## 対象範囲・対象外

- Node.jsのPRは最新mainを起点に、正本の `.node-version` とREADMEの現行バージョンを24.19.0から24.22.3へ更新する。`engines.node` の24.xと依存・lockfileを維持する。
- Node.jsのPRでCIが通ってから、Next.jsと対応する `eslint-config-next` を16.4.3から16.4.6へ更新する別PRを作る。Node.jsのPRが未マージの場合、Next.jsのPRはそのブランチを比較元とし、更新済みのNode.js上で検証する。
- Next.jsのPRでは `package.json`、npmで生成する `package-lock.json`、READMEの現行バージョンおよび作業記録を更新する。既存のoverridesと他の直接依存の指定は維持する。
- Cloud作業環境が利用できない場合は、Next.jsのPRに一時的なGitHub Actionsジョブを置いて、固定Nodeとnpmでlockfileを生成する。公開レジストリの依存情報だけを扱い、生成した内容とハッシュを照合した後、その一時設定を外して通常CIを実行する。
- Node.js 26系への移行、広範な依存更新、アプリの仕様変更、Vercel設定・本番環境の操作、PRのマージは対象外。

## 受入条件

- [ ] AC-01: Node.jsのPRの最終コミットで実際に24.22.3を使用し、依存監査・lint・型検査・テスト・build・ブラウザQAが通る。依存の固定内容は同一。
- [ ] AC-02: Node.jsのCI成功後、Next.jsのPRでNext.jsと対応するESLint設定を16.4.6へ更新し、npmでlockfileを再生成する。通常CIの最終コミットで同じ検証を行う。
- [ ] AC-03: Next.js更新の前後の監査を比較し、確認したNext.jsの指摘の解消と、残る指摘を記録する。一時的なlockfile作成用CIは最終差分に含めない。

## 関連記録

- [Node.js 24.22.3のリリース](https://github.com/nodejs/node/releases/tag/v24.22.3)
- [Next.js 16.4.6のリリース](https://github.com/vercel/next.js/releases/tag/v16.4.6)
- [基準mainのCIと監査結果](https://github.com/tyask/mille/actions/runs/44554252958)

## 進捗

- 利用者から「じゃあそうして」と、Node.jsを先に検証しNext.jsを別PRで進める方針への承認を取得。
- 保存済みIssue本文への別承認後、Node.js更新から開始する。
