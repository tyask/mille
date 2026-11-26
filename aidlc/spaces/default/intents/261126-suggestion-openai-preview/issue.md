## 目的・背景

Milleの献立提案をOpenAI APIに直接接続し、既存のOpenAI API組織のクレジットを使えるようにします。献立条件と追加要望を反映した日本語の提案を、既存の予定保存・実績化につなげます。

## 対象範囲・対象外

- 既存のサーバー側アダプターをOpenAI Chat Completions APIへ直接接続する方式に変更します。第一候補はGPT-6 Luna（`gpt-6-luna`）です。推論地域は標準のグローバル接続とし、日本への固定条件を外します。OpenAI APIへのリクエストに `store: false` を指定します。ZDRの有効化や確認は、実モデル試験および今後の利用の前提条件から外します。
- 初回の実モデル検証は専用PR Previewの架空データで行います。送信は献立条件、同じワークスペースの最近の記録済みの料理名、追加要望、修正に必要な候補の要約に絞ります。入出力に上限を設け、運用ログにはモデル、トークン数、処理時間、成否とリクエストIDを記録します。Cloud・CIではサンプル応答を使います。
- 実モデルの試験は最大10回です。入出力各2,000トークンで10回の場合、標準の公開単価で約0.012米ドルを見込みます。実行前に対象のOpenAI APIプロジェクトで `gpt-6-luna` の利用可否と既存APIクレジット残高を確認します。新規課金、永続資格情報の発行、権限拡大が必要な場合は別途承認を受けます。対象は架空データでの検証までとし、本番有効化、写真解析、栄養計算は別工程とします。
- `OPENAI_API_KEY` は利用者が Vercel `fumin1/mille` に **Preview専用・ブランチ指定なし** のプロジェクト共通Secretとして登録したものを使用します。登録後に作成した対象Previewにビルド時と実行時の環境変数として適用されます。実APIを使うのは、保護付きのPR #75専用Previewで現在の完全HEAD、デプロイID、専用DBを照合し、明示的に有効化して架空データで提案の生成・修正を行う場合に限ります。通常の自動テストは模擬応答を使い、正式Previewの自動ブラウザ確認はテスト認証と読み取りを行います。試験の成否にかかわらず実モデルを無効化し、状態と試験件数を再確認します。

## 受入条件

- [ ] AC-01: 明示的に有効化した専用PR Previewで、OpenAI APIから献立条件に沿った日本語の候補を複数取得し、追加要望で更新できます。採用した候補を予定として保存し、実績化できます。
- [x] AC-02: 提案の取得・更新に既存の認証と所属確認が適用されます。模擬応答で直接接続時の送信項目と上限、構造化出力、不正応答・タイムアウト時の入力と直前候補の保持、再送時の非重複、専用Previewの10回上限を確認します。
- [ ] AC-03: Cloud・CIでサンプル応答の回帰を確認します。専用PR Previewでは対象のOpenAI APIプロジェクトのモデル利用可否と既存APIクレジットを確認して架空データで試験し、モデル、リクエストID、応答時間、トークン数、費用を記録します。最終SHAの独立レビュー、Cloud検証、GitHub CI、正式PR Previewの結果を記録します。

## 関連記録

- [既存のドラフトPR #75](https://github.com/tyask/mille/pull/75) · [P2の初回実装 Issue #70](https://github.com/tyask/mille/issues/70) · [共通Preview環境変数 Issue #76](https://github.com/tyask/mille/issues/76)
- [提案と会話の技術設計](https://github.com/tyask/mille/blob/main/docs/design/technical-design.md#p2-提案と会話の内部契約)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [OpenAIのデータ保持設定](https://developers.openai.com/api/docs/guides/your-data#configuring-data-retention-controls)
- [Milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md#承認と完了条件)

## 進捗

- 利用者の指示に基づき、OpenAI APIへの直接接続と日本推論の固定解除を計画に反映しました。この保存済み本文への承認後に、PR #75で切り替えます。
- 当初の計画では、OpenAIの資格情報を専用デプロイの実行時だけに渡す経路の整備が必要でした。
- Gateway版の完全HEAD `af523ca6d32e30b2ddef6c0fad6800a648df8a4d` は、独立レビュー、Cloud検証、push・PRの各371テストとブラウザQA 4/4、正式Previewのstatus・verifyを完了しました。直接接続版の受入条件は変更後に再検証します。 [旧方式の検証記録](https://github.com/tyask/mille/pull/75#検証結果)

- 直接接続版の [ドラフトPR #75](https://github.com/tyask/mille/pull/75) の完全HEAD `64dab3a950b6c3edc7f78b975c5a9639bbbe0e32` で独立レビュー、高速検査、372テスト、build、CloudブラウザQA 4/4を確認しました。模擬応答とPGliteで直接接続の契約、既存の所属・再送制御、最大10回の予約を照合し、AC-02をチェックしました。 [独立レビュー](https://github.com/tyask/mille/pull/75#issuecomment-7145823655)

- 同じ完全HEADでpush・PRの各最新試行が成功し、372テストとブラウザQA 4/4を確認しました。正式PR Previewのstatus・verifyでも専用デプロイとDB、実行時SHA、正式ブラウザ4/4を照合しました。この時点では実モデル試験の資格情報経路と、対象プロジェクトのZDR・クレジットが確認待ちでした。AC-01・03は未確認、PR #75はドラフトでした。 [push CI](https://github.com/tyask/mille/actions/runs/45497593629/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/45497610121/attempts/1) · [status](https://github.com/tyask/mille/actions/runs/45498018074/attempts/1) · [verify](https://github.com/tyask/mille/actions/runs/45498240634/attempts/1)

- 最新の `main` を取り込んだ [PR #75](https://github.com/tyask/mille/pull/75) のHEAD `49f42a30f0cddf0a7b33ce404aeccb68cae53c67` で、独立レビュー、高速検査、全372テスト、ビルド、Cloudブラウザ4/4、両CIを確認しました。キー登録後の新しい正式Previewを作成し、同じHEADの `status`・`verify` とブラウザ4/4を照合しました。献立生成や修正の実APIリクエストは未実施で、実モデルのAC-01・03は確認待ちです。[レビュー](https://github.com/tyask/mille/pull/75#issuecomment-7191128632) · [push CI](https://github.com/tyask/mille/actions/runs/45813411258/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/45813418960/attempts/1) · [状態確認](https://github.com/tyask/mille/actions/runs/45813758915/attempts/1) · [正式ブラウザ確認](https://github.com/tyask/mille/actions/runs/45813947412/attempts/1)

- 利用者の許可を受けて、実モデル試験の資格情報経路をPreview共通Secretに更新しました。この時点では、更新後の本文への承認とOpenAI側の条件確認が残っていました。[共通設定の運用手順](https://github.com/tyask/mille/blob/eb8707ba2ce876d34853abad22228cbeea2e9b55/docs/pr-preview.md#プロジェクト共通の-preview-環境変数)

- 利用者は、登録したキーで `gpt-6-luna` が利用でき、既存のAPIクレジットで試験を賄えることを確認しました。利用者の指示に従い、ZDRの有効化と確認を今回の試験および今後の利用の前提条件から外し、`store: false` を指定します。対象HEADの模擬テスト7件で送信時の `store: false` を確認しました。今回の本文への承認後に正式Previewの手順を更新します。