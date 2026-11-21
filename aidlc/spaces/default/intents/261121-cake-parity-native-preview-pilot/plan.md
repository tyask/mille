# Neon Native Previewの試験用DB準備と削除

Issue #32 AC-03 の準備として、既存の `Mille PR Preview` 管理ジョブに試験モードを設ける。既存の共用 `mille-preview`、空の既定テンプレート、常設 endpoint、Vercel の Preview のみのストア接続を照合し、明示された2件を直列に処理する。

信頼済み main に対して試験用文書だけが追加された Git ソースを照合してから、静的な準備用デプロイを要求する。Vercel の成果物、接続先ホストのダイジェスト、作成期間、Neon の親・ブランチ・endpoint を照合し、既定・常設・観測済みの相手との資格情報の分離を確認した場合だけ、信頼済み migration と架空ユーザーで専用 DB を準備する。終了時は所有の証拠を保持し、専用ブランチと endpoint の不在を確認してからデプロイを整理する。

架空応答で信頼済みソース、プロバイダーの設定・成果物・分岐、資格情報の共有、競合・不明な要求・削除を検証する。最終 SHA の独立レビュー、Cloud テスト、push・PR CI、通常の正式 Preview を確認する。

外部設定を切り替える前は現行ジョブを使用する。設定変更後の試験は別途承認を得て実施し、Vercel が実際に注入する資格情報の分離とアプリ Preview は実環境の結果を確認してから後続工程に進む。

[承認済みIssue #32](https://github.com/tyask/mille/issues/32) · [Cake の準備デプロイ](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/preview/preview-service.ts#L50-L97)
