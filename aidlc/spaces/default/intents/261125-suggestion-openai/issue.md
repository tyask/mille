## 目的・背景

Milleの献立提案をOpenAI APIに直接接続し、既存のOpenAI API組織のクレジットを使えるようにします。献立条件と追加要望を反映した日本語の提案を、既存の予定保存・実績化につなげます。

## 対象範囲・対象外

- 既存のサーバー側アダプターをOpenAI Chat Completions APIへ直接接続する方式に変更します。第一候補はGPT-6 Luna（`gpt-6-luna`）です。推論地域は標準のグローバル接続とし、日本への固定条件を外します。ZDRは対象のAPIプロジェクトで有効であることを確認し、リクエストに `store: false` を指定します。
- 初回の実モデル検証は専用PR Previewの架空データで行います。送信は献立条件、同じワークスペースの最近の記録済みの料理名、追加要望、修正に必要な候補の要約に絞ります。入出力に上限を設け、運用ログにはモデル、トークン数、処理時間、成否とリクエストIDを記録します。Cloud・CIではサンプル応答を使います。
- 実モデルの試験は最大10回です。入出力各2,000トークンで10回の場合、標準の公開単価で約0.012米ドルを見込みます。実行前に対象プロジェクトの利用資格、残高、資格情報を専用デプロイの実行時だけに渡す経路を確認します。新規課金、永続資格情報の発行、権限拡大が必要な場合は別途承認を受けます。対象は架空データでの検証までとし、本番有効化、写真解析、栄養計算は別工程とします。

## 受入条件

- [ ] AC-01: 明示的に有効化した専用PR Previewで、OpenAI APIから献立条件に沿った日本語の候補を複数取得し、追加要望で更新できます。採用した候補を予定として保存し、実績化できます。
- [ ] AC-02: 提案の取得・更新に既存の認証と所属確認が適用されます。模擬応答で直接接続時の送信項目と上限、構造化出力、不正応答・タイムアウト時の入力と直前候補の保持、再送時の非重複、専用Previewの10回上限を確認します。
- [ ] AC-03: Cloud・CIでサンプル応答の回帰を確認します。専用PR Previewでは対象のOpenAI APIプロジェクトのZDRとクレジットを確認して架空データで試験し、モデル、リクエストID、応答時間、トークン数、費用を記録します。最終SHAの独立レビュー、Cloud検証、GitHub CI、正式PR Previewの結果を記録します。

## 関連記録

- [既存のドラフトPR #75](https://github.com/tyask/mille/pull/75) · [P2の初回実装 Issue #70](https://github.com/tyask/mille/issues/70)
- [提案と会話の技術設計](https://github.com/tyask/mille/blob/main/docs/design/technical-design.md#p2-提案と会話の内部契約)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [OpenAIのデータ保持設定](https://developers.openai.com/api/docs/guides/your-data#configuring-data-retention-controls)
- [Milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md#承認と完了条件)

## 進捗

- 利用者の指示に基づき、OpenAI APIへの直接接続と日本推論の固定解除を計画に反映しました。この保存済み本文への承認後に、PR #75で切り替えます。
- 現行の正式Preview管理は、OpenAIの資格情報を専用デプロイに渡す経路の整備を要します。実モデル試験の前に、この経路とOpenAI側のZDR・残高を照合します。
- Gateway版の完全HEAD `af523ca6d32e30b2ddef6c0fad6800a648df8a4d` は、独立レビュー、Cloud検証、push・PRの各371テストとブラウザQA 4/4、正式Previewのstatus・verifyを完了しました。直接接続版の受入条件は変更後に再検証します。 [旧方式の検証記録](https://github.com/tyask/mille/pull/75#検証結果)