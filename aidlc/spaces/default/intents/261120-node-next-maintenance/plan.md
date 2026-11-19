# Node.jsとNext.jsの段階的な更新

Node.js 24系のセキュリティ更新と、Next.jsの監査指摘に対応する。別のdraft PRで、変更の影響を分けて検証する。

1. 最新mainからNode.jsのブランチを開始する。正本の `.node-version` とREADMEの現行バージョンを24.19.0から24.22.3に変更し、`engines` 、`package.json` 、lockfile、CI定義を保持する。
2. Node PRの完全HEADのCIでNode/npmの実値と依存監査・lint・型検査・テスト・build・ブラウザQAを確認する。
3. Node PRの成功後、Nodeの検証済みHEADからNextの専用ブランチを作成する。Node PRが未マージならNext PRのbaseにNodeブランチを指定し、差分とCIを分ける。
4. `next` と対応する `eslint-config-next` を16.4.6へ更新し、検証済みNode/npmで既存lockfileを入力にnpmがlockfileを生成する。Cloudが使えない場合、Next PRで一時的な読み取り専用Actionsジョブを使い、公開依存情報の生成物・SHAを照合する。最終HEADから一時ジョブを外す。
5. 最終差分を独立レビューし、Node／NextそれぞれのCIと監査結果をPRとIssueへ記録する。両PRは別途の明示指示までマージしない。

Node 26、他の直接依存・overrides、アプリの仕様、Vercel設定、本番操作は対象外。
