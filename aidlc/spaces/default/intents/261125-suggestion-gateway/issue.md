## 目的・背景

P2の初回実装で、献立の提案、追加要望、予定の採用、実績化をサンプル応答で利用できるようにしました。実LLMを既存の提案処理につなぎ、日本語の献立案が入力条件と追加要望を反映することを確認します。

## 対象範囲・対象外

- 既存の提案アダプターにVercel AI Gateway接続を追加します。第一候補はGPT-6 Luna（`openai/gpt-6-luna`）です。OpenAIの提供経路、日本での推論、リクエスト単位のゼロデータ保持（ZDR）を指定します。Gatewayの受信地点は別の地域になる場合があります。
- 初回は専用PR Previewで架空データを使います。送信項目は献立条件、同じワークスペースの最近の記録済みの料理名、追加要望、修正に必要な候補の要約に絞ります。入出力に上限を設け、運用ログにはモデル、トークン数、処理時間、成否を記録します。通常のCloud・CIではサンプル応答を使います。
- 実モデルの試験は最大10回とします。入出力各2,000トークンで10回の場合、日本リージョンの公開単価で約0.013米ドルの推論費用を見込みます。実行前に対象アカウントでの利用可否と料金を確認し、新規課金が必要な場合は別途承認を受けます。対象は架空データによる検証までとし、本番での有効化と写真解析・栄養計算は別工程とします。

## 受入条件

- [ ] AC-01: 明示的に有効化した専用PR Previewで、献立条件に沿った日本語の候補を複数表示し、追加要望で更新できます。採用した候補を既存の操作で予定として保存し、実績化できます。
- [ ] AC-02: 提案の取得・更新に既存の認証と所属確認が適用されます。模擬応答を使ったテストで送信項目と上限、構造化出力の検証、不正応答・タイムアウト時の入力と直前候補の保持、再送時に推論を重複させないことを確認します。
- [ ] AC-03: Cloud・CIでサンプル応答による回帰テストを実行します。専用PR Previewでは架空データで日本語の提案と追加要望を試し、提供経路、推論地域、応答時間、トークン数、費用を記録します。最終SHAの独立レビュー、Cloud検証、GitHub CI、正式PR Previewの結果を記録します。

## 関連記録

- [P2の初回実装 Issue #70](https://github.com/tyask/mille/issues/70)
- [提案と会話の技術設計](https://github.com/tyask/mille/blob/main/docs/design/technical-design.md#p2-提案と会話の内部契約)
- [GPT-6 Lunaのモデルと提供経路](https://vercel.com/ai-gateway/models/openai/gpt-6-luna#providers)
- [AI Gatewayの推論地域](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference) · [ゼロデータ保持](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr)
- [Milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md#承認と完了条件)

## 進捗

- チャットで提示した計画に対し、利用者から「承認します」と回答を受けました。GitHubに保存した本Issue本文への別承認後に実装を開始します。