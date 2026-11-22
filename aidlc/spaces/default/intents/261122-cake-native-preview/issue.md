## 目的・背景

Cakeの現行手順を基準に、milleのCI、本番DBマイグレーション、PR専用PreviewとReady、常設Previewとマージ後確認、旧デプロイ整理を揃える。全工程をこのIssueで追跡し、段階ごとにPRと検証結果を関連付ける。

## 対象範囲・対象外

- 開発・デプロイ運用を対象とする。献立画面などのアプリ機能は各機能の開発工程で扱う。
- mille専用のリポジトリ、デプロイ、DB、資格情報を使う。信頼済みの `main` から管理し、PRのソースを管理資格情報付きで実行しない。既存の本番DB識別・SQLハッシュ照合と、Previewの本番分離を使う。
- 各段階でテスト、最終コミットの独立レビューとCloud検証、GitHub CIを行い、結果をPRに記録する。新しい確認を実測してから対応する運用を切り替える。マージ、本番操作、外部設定の切り替え、実削除の有効化は別途承認を受ける。

## 受入条件

- [x] AC-01: `main` と `codex/**` へのpush、`main` 向けPRでCIを実行する。固定したActionsとPlaywright環境で、構造・文書検査、全テスト、build、Cloud QAを行い、現HEADに対応する最新のpush・PR検証結果を確認できる。Issue・PRテンプレート、Intentと検証記録の手順を揃え、既存の依存脆弱性監査は個別コマンドとして利用できる。
- [x] AC-02: Vercelの本番ビルドでNext.jsのbuild成功後、公開前に既存ランナーが接続先・DBの環境識別・適用済みSQLのハッシュを照合し、未適用分だけを順に適用する。差分なし、増分適用、ビルド失敗時にDB処理へ進まないこと、接続先・履歴の不一致や移行失敗で公開が止まることを検証する。初期化とseedは専用手順で扱う。
- [ ] AC-03: PR専用PreviewでNeon Nativeの分岐を導入する。常設DBや本番DBのデータを引き継がない、専用の空の既定ブランチを確保する。PRと現HEAD、Vercelデプロイ、DBブランチ・エンドポイント・世代を照合する。PR間の分離、同じPRのデータ保持、マージ・クローズ時の専用資源削除を確認する。
- [ ] AC-04: 信頼済みの `main` から正式Previewの状態確認と再検証を行い、PC・スマホ × 架空A/Bのブラウザ検証を現HEADの証拠として保存する。利用可能と確認してから、Cakeに沿って現HEADのCI、独立レビューとCloud検証、正式Previewとアプリ変更時の正式ブラウザ検証をReady条件にする。Ready後の修正はdraftに戻して新しいHEADを再検証する。
- [ ] AC-05: `main` と同じコミットを常設Previewにデプロイする。正式ブラウザ検証が成功してから固定エイリアスを更新し、既存の常設URLとDBを維持する。マージ後はmain CI、本番デプロイとエイリアス、常設Preview、PR専用資源の削除を同一コミットに対応付け、IssueにPRごとの結果を記録する。案件完了を指定したPRで、関連する検証と手動確認がすべて揃った場合にIssueを閉じる。
- [ ] AC-06: 旧デプロイ整理は最初に読み取り専用で削除候補を一覧化する。現用エイリアスや既存の常設URL、進行中のデプロイ、PR専用資源を保護し、承認された候補だけを削除直前と直後に照合する。実削除の承認後に、毎朝6時（日本時間）の実行を有効にする。

## 関連記録

- [Cakeの開発・QA手順](https://github.com/tyask/Cake/blob/main/docs/development-workflow.md)
- [Cakeの本番ビルド](https://github.com/tyask/Cake/blob/main/scripts/build/vercel-build.ts)
- [Cakeの旧デプロイ整理](https://github.com/tyask/Cake/blob/main/.github/workflows/deployment-retention.yml)
- [milleの開発ルール](https://github.com/tyask/mille/blob/main/AGENTS.md)
- [milleのPR専用Preview手順](https://github.com/tyask/mille/blob/main/docs/pr-preview.md)

## 進捗

- チャットで提示した全体計画に対し、利用者から「承認します」と回答を受けた。GitHubに保存したIssue本文への別承認後に実装を開始する。

- 保存済み本文への別承認を受け、AC-01の変更をPR #33に実装した。最終HEAD `df52eaf58c21d330dac1cee55d9f2d84ad12c124` で独立レビュー、Cloudの高速検査・テスト181件・build・ブラウザQA 4件を確認した。
- 新しいpush CIとPR CIの最新試行が成功した。PR CIはソースHEADと、実際にテストしたマージコミット `a228cefd32c7ce3d7be763d865de6972892aa523` を照合した。正式PreviewのREADYも確認し、PR #33をReady for reviewにした。AC-01はマージ後の `main` push CIの確認後にチェックする。 [PR #33](https://github.com/tyask/mille/pull/33) · [push CI](https://github.com/tyask/mille/actions/runs/44870841511/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44871021427/attempts/1) · [正式Preview](https://mille-hk3yg3ncm-fumin1.vercel.app)

- 利用者の承認を受け、PR #33を `main` の `e3f77a04fcfb21b672b1d46786d45208e261bbc2` へマージした。同じコミットの新しいmain CIで、固定Playwrightイメージ、ソースSHAとテスト対象SHA、181テストとブラウザQA 4件の成功、artifactを照合し、AC-01を完了した。Vercelの本番デプロイと本番エイリアスの一致、PR専用Previewの自動削除を確認した。 [PR #33](https://github.com/tyask/mille/pull/33) · [main CI](https://github.com/tyask/mille/actions/runs/44872571754) · [本番デプロイ](https://vercel.com/fumin1/mille/Cs6xjNJpBTqMkoPorohwAG1PXTTz) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44872571993/job/136750198057)

- AC-02をPR #34に実装した。最終HEAD `7c831390a2cb8c87bbfd72c00ea558d60b3f2d58` の独立レビュー、Cloud高速検査・186テスト・build・ブラウザQA 4件、pushおよびPRの最新CIが成功した。使い捨てDBで増分適用・再実行・履歴不一致・ロールバックを確認した。
- 正式PreviewがREADYとなり、実際のVercelビルドで対象ホストとデプロイを識別してNext.jsをbuildすることを確認した。PR #34はReady for review。AC-02はマージに伴う本番初回自動実行のログとDB履歴の照合後にチェックする。 [PR #34](https://github.com/tyask/mille/pull/34) · [push CI](https://github.com/tyask/mille/actions/runs/44873280590/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44873410067/attempts/1) · [正式Preview](https://mille-a2w4q5dmv-fumin1.vercel.app)

- 利用者の承認を受け、PR #34を `main` の `d764473201322bf10889991ab99d168202a82c81` にマージした。本番ビルドログでVercelホストの確認、Next.jsのビルド成功、本番DBの照合・移行工程の開始と完了、公開の順序を確認した。実行前後で001〜004のハッシュと適用日時が一致した。追加適用対象は0件だった。本番エイリアスが同じデプロイを参照し、AC-02を完了した。 [PR #34](https://github.com/tyask/mille/pull/34) · [本番デプロイ](https://vercel.com/fumin1/mille/Gjp4AdhUaVwetRqcgwd3M4kHTuGp)
- 同じSHAのmain CIが186テストとブラウザQA 4件に成功した。PR #34専用のVercelデプロイ、Neonブランチ、エンドポイントの自動削除を照合した。 [main CI](https://github.com/tyask/mille/actions/runs/44881659006) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44881659034/job/136778126879)

- AC-03 の静的な準備用ビルドを PR #35 に実装した。最終 HEAD `4925ff1566ef8ec9c41a4490a7f602f7eba02b0c` で独立レビュー、Cloud 高速検査・196テスト・通常 build・ブラウザ QA 4件を確認した。架空の Vercel ビルド情報と DB 接続設定なしで準備用ファイル2件だけを出力し、通常 build に戻ることを確認した。push と PR の最新 CI は成功し、現行の正式 Preview は同じ HEAD で READY だった。 [PR #35](https://github.com/tyask/mille/pull/35) · [push CI](https://github.com/tyask/mille/actions/runs/44882381881/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44882523517/attempts/1) · [正式Preview](https://mille-omjd0ooif-fumin1.vercel.app)
- Native 管理ジョブの作成、空の既定ブランチを持つ専用プロジェクトの用意、プロバイダーの接続と試験が次工程。AC-03 は実環境で分離・更新時の保持・マージとクローズ時の削除を照合した後にチェックする。

- 利用者の承認を受け、PR #35を main の `1f4013b04299b0b159958d74f096233927e4a863` にマージした。同一 SHA の main CI で196テストとブラウザ QA 4件が成功した。本番で Next.js ビルド・DB 照合・公開の順に完了し、本番エイリアス3件が一致した。001〜004のSQLハッシュと適用日時は実行前後で一致した。PR 専用デプロイ、Neon branch、endpoint の自動削除と常設 Preview の READY を確認した。 [PR #35](https://github.com/tyask/mille/pull/35) · [main CI](https://github.com/tyask/mille/actions/runs/44883143767/attempts/1) · [本番デプロイ](https://vercel.com/fumin1/mille/HYbSafnjR1KQ878gHMhVCGxooYvo) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44883143756/job/136782666513)

- 専用の `mille-native-preview` を既存の Neon Free 契約内で作成する承認を受けた。Vercel Marketplace の `fumin1` に Free 契約と作成枠を確認した。認証済みの作成手段が利用可能になり次第、空の既定ブランチを持つリソースを作成し、Neon と Vercel の情報を照合する。 [Neon の作成手順](https://neon.com/docs/guides/vercel-managed-integration#add-another-database-project)

- AC-03 の読み取り専用の Git ソース照合を PR #36 に実装した。最終 HEAD `903bfe118474884f7e35ae3fd2fb0219f6ff6ada` で独立レビュー、高速検査、202テスト、build、Cloud ブラウザ QA 4件が成功した。GitHub API から取得した実際の PR #36 と Git オブジェクトで、Cloud のソース照合が候補を返すことを確認した。push と PR の最新 CI と、同じ HEAD の正式Previewの READY を確認した。信頼済み main での手動実行はマージ後に検証する。 [PR #36](https://github.com/tyask/mille/pull/36) · [push CI](https://github.com/tyask/mille/actions/runs/44883658877/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44883814432/attempts/1) · [正式Preview](https://mille-q9rykyq4k-fumin1.vercel.app)

- 利用者の承認を受け、PR #36を main の `985659fd269fc71a5f7706331fecf7a88bcc3976` にマージした。同一 SHA の main CI で202テストとブラウザ QA 4件が成功した。本番のビルド・DB 照合・公開が完了し、本番エイリアス3件と001〜004の適用履歴を照合した。PR 専用デプロイ、Neon branch、endpoint の自動削除と常設 Preview の READY を確認した。 [PR #36](https://github.com/tyask/mille/pull/36) · [main CI](https://github.com/tyask/mille/actions/runs/44887981749/attempts/1) · [本番デプロイ](https://vercel.com/fumin1/mille/5ZBH2jQ2xDCoAhs9kcwF8w3qFkb3) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44887981697/job/136797430205)

- 同じ main SHA に、GitHub の読み取り権限だけで実行する手動の `inspect-native` が含まれることを確認した。GitHub 接続には新規の手動実行機能がなく、この環境の CLI は API で `Forbidden` を返すため、実行の確認は権限のあるセッションで行う。 [導入済みワークフロー](https://github.com/tyask/mille/blob/985659fd269fc71a5f7706331fecf7a88bcc3976/.github/workflows/pr-preview.yml#L25-L49)

- AC-03 の未接続リソース照合を PR #37 に実装した。最終 HEAD `3fab62a2a2b42359d364b5d348a282f0a595e42a` で独立レビュー、高速検査、209テスト、build、Cloudブラウザ QA 4件が成功した。架空の応答で6件の読み取り専用API、別リソース・プラン・接続状態の拒否、資格情報の抑制を確認した。push・PR の最新 CI と同じ HEAD の正式Previewが成功した。専用リソースの実データと空の既定 DB は作成後に照合する。 [PR #37](https://github.com/tyask/mille/pull/37) · [push CI](https://github.com/tyask/mille/actions/runs/44888417489/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44888574437/attempts/1) · [正式Preview](https://mille-4olp6qdtr-fumin1.vercel.app)

- PR #37 と完全 HEAD SHA を指定して `main` の `inspect-native` の実行を試みた。この環境の GitHub CLI はワークフロー API の読み取りで `Forbidden` を返し、実行は開始されていない。 [GitHub Actions](https://github.com/tyask/mille/actions/workflows/pr-preview.yml)

- 利用者の承認を受け、PR #37を main の `e587d5f95f3f5371f41c8ec4b2bb89e391a1533d` にマージした。同じ SHA の main CI で209テストとブラウザ QA 4件が成功した。本番のビルド・DB 照合・公開が完了し、エイリアス3件が同じ本番デプロイを参照した。SQL 001〜004の適用履歴は実行前後で一致した。PR 専用の Vercel デプロイ、Neon branch、endpoint の自動削除を確認した。常設Previewは同じURLでREADYだった。 [PR #37](https://github.com/tyask/mille/pull/37) · [main CI](https://github.com/tyask/mille/actions/runs/44890002836/attempts/1) · [本番デプロイ](https://vercel.com/fumin1/mille/7M5nmbVCz5E3GQPjeSikRUi5hi8T) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44890002802/job/136803645829)

- AC-03 の実環境検証を続けるには、承認済みの専用リソースを Vercel Marketplace の既存 Free 契約で作成する。Vercel の `fumin1` で `mille-native-preview` をシンガポール（`sin1`）に作成し、Auth と Realtime をオフ、アプリへの接続は **Skip** とする。作成後のリソースURLで、両プロバイダーの ID・未接続状態を照合し、既定 DB の中身を読み取りで確認する。GitHub の `inspect-native` は手動実行アクセスが得られた後、次に開いている対象 PR で実行する。 [Vercel Integrations](https://vercel.com/fumin1/~/integrations) · [Neon の手順](https://neon.com/docs/guides/vercel-managed-integration#add-another-database-project) · [GitHub Actions](https://github.com/tyask/mille/actions/workflows/pr-preview.yml)

- 利用者の指示を受け、Cake のように常設 Preview と PR Preview で既存の `mille-preview` を共用する方針に更新した。以前の専用プロジェクト作成の手順は、この共用手順に置き換える。現在の `main` に常設用マーカーがあり、常設用の Vercel Git ブランチに限定したホスト設定と一致した。独立した `mille-pr-template` は `neondb`、`postgres`、`template1` の読み取り専用の確認で空だった。常設用 endpoint を保持したまま、Native の管理処理を用意してから空のテンプレートを既定にする。 [Cake の共通設定](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/preview.config.json) · [Neon の分岐仕様](https://neon.com/docs/guides/vercel-managed-integration#enable-automated-preview-branching-recommended)

- 共用向けの切替前照合と手順を PR #38 に実装した。最終 HEAD `b147f53a056e1a94287375e5b88a1b7fc7ae9a99` で独立レビュー、Cloud 高速検査、211テスト、build、ブラウザQA 4件が成功した。push・PR の最新 CI と同じ HEAD の正式 Preview も成功し、既存の空テンプレートが通常の PR DB の親であることを確認した。Vercel の既存 `mille-preview` ストアの ID を照合し、Native の管理処理と試験準備を揃えてから Vercel と Neon の切替を行う。 [PR #38](https://github.com/tyask/mille/pull/38) · [push CI](https://github.com/tyask/mille/actions/runs/44904043374/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44904209761/attempts/1) · [正式Preview](https://mille-1ly8j1khy-fumin1.vercel.app)

- 利用者から、旧 PR 管理ジョブの一時停止を許容し、切替手順を簡素にする指示を受けた。旧方式と Native を並行稼働させず、既存の `mille-preview` の中で一度だけ切り替える。現時点で開いている PR は #38 のみで、旧方式の専用ブランチも `mille-pr-38` だけだった。#38 のマージ後、現行ジョブによるデプロイと DB の後片付けを確認する。 [PR #38](https://github.com/tyask/mille/pull/38)
- Native の切替に必要な実装は、現行の信頼済み管理ジョブを再利用した Native 分岐の起動、専用 DB の準備、アプリへの接続、PR 終了時の削除とする。管理処理と Vercel の接続先の準備が揃った段階で旧ジョブを休止し、空の `mille-pr-template` を既定に変更して、既存の Vercel プロジェクトを Preview 限定で接続する。常設 Preview は現在の `main` の endpoint を使う。試験用 PR で分離・更新時の保持・終了時の削除を照合する。Neon の通常分岐はロールのパスワードを引き継ぐため、Vercel Native が渡す資格情報で他の PR DB に接続できないことを試験で確認し、資格情報の値は記録しない。 切替に失敗した場合は Native 接続を戻し、`main` を既定にして現行ジョブを復旧する。 [現行ワークフロー](https://github.com/tyask/mille/actions/workflows/pr-preview.yml) · [Neon の分岐仕様](https://neon.com/docs/guides/vercel-managed-integration#enable-automated-preview-branching-recommended) · [Neon のロール仕様](https://neon.com/docs/guides/protected-branches#new-passwords-generated-for-postgres-roles-on-child-branches)

- 利用者の承認を受け、PR #38を main の `36c8dbe00bcd6044b4e9bd93fe2ec5a4755ef79d` にマージした。同じ SHA の main CI で211テストとブラウザ QA 4件が成功した。本番ビルド、DB 照合、公開が完了し、001〜004の適用履歴は実行前後で一致した。エイリアス3件、PR専用の Vercel デプロイと Neon branch・endpoint の自動削除、常設PreviewのREADYを確認した。 [PR #38](https://github.com/tyask/mille/pull/38) · [main CI](https://github.com/tyask/mille/actions/runs/44909111580/attempts/1) · [本番デプロイ](https://vercel.com/fumin1/mille/7NXWXhvte3SWu3W8woWmpcBtuUfW) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44909111557/job/136861003318)

- 利用者が共有した Vercel の既存 `mille-preview` ストア `store_tzb7wMnsJ8PsmiI4` の `externalResourceId` が Neon の `billowing-cherry-59956184` と一致した。Free 契約、接続先0件、現在の既定は常設用 `main`、分岐元候補と常設の endpoint の分離を確認した。実 API の応答から識別情報だけを使って共用構成の照合を通し、空テンプレートの3データベースを読み取り専用 SQL で再確認した。次の実環境手順は、Native の管理処理と、制御した試験での DB 資格情報の分離確認。実際の Vercel 接続は認証済み操作が可能な経路から行う。 [確認した Vercel ストア](https://vercel.com/fumin1/~/integrations/neon/icfg_lQa8FrtYd7ppoLmOxnGzOvGf/resources/storage/store_tzb7wMnsJ8PsmiI4/guides)

- AC-03の実環境試験に向け、既存の `mille-preview` で2件の試験専用PRの DB を準備・削除する管理処理を PR #39 に実装した。最終 HEAD `52b610ba04472a96ec65fac0cc4f71333c56d4d7` の独立レビュー、Cloud の検査・通常ビルド・試験用静的ビルド・242テスト・ブラウザQA 4件が成功した。push・PRのCIでも242テストとブラウザQA 4件が成功し、PRのCIが検証した `9ef87dcc78706909c4fc18c5c5ae104c4a1d910f` の内容は現HEADと同じだった。通常の公式Preview `dpl_HnFHxoSU24NnL7QcnzbYsQnsS13u` が同じHEADで `READY` となり、管理ジョブ・Vercel・GitHubの記録が一致した。Native試験はコードをマージして切替を承認した後に実施する。VercelとNeonの接続設定および既定ブランチは切り替えておらず、実環境での資格情報の分離と一般PRのアプリの確認は未完了。 [PR #39](https://github.com/tyask/mille/pull/39) · [独立レビュー](https://github.com/tyask/mille/pull/39#issuecomment-7063910287) · [push CI](https://github.com/tyask/mille/actions/runs/44912522090/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44912711005/attempts/1) · [通常の公式Preview](https://mille-3q0uc0qap-fumin1.vercel.app) · [管理ジョブ](https://github.com/tyask/mille/actions/runs/44912732415/job/136871880346)

- 利用者の承認を受け、PR #39 を main の `f8c54199e3764a7e6b3c711c64f5991d7f29a85f` にマージした。PR の検証済み HEAD `52b610ba04472a96ec65fac0cc4f71333c56d4d7` と内容が一致し、main CI の試行1で242テストとブラウザQA 4件が成功した。同じ SHA の本番ビルドで DB の照合と移行処理が完了し、追加適用は0件だった。読み取り専用で確認した001〜004の名前・ハッシュ・適用時刻は実行前後で一致し、既存の本番エイリアス3件は新デプロイを参照した。PR専用VercelデプロイとNeonのブランチ・endpointの削除を確認し、常設Previewは同じURLで `READY` だった。 [PR #39](https://github.com/tyask/mille/pull/39) · [main CI](https://github.com/tyask/mille/actions/runs/44913538204/attempts/1) · [QA成果物](https://github.com/tyask/mille/actions/runs/44913538204/artifacts/14711016716) · [本番デプロイ](https://vercel.com/fumin1/mille/HBPMWTWygHzjnCkrSDN3FXqSLmEv) · [push時の削除ジョブ](https://github.com/tyask/mille/actions/runs/44913538171/job/136874249311) · [クローズ時の削除ジョブ](https://github.com/tyask/mille/actions/runs/44913549975/job/136874292488) · [常設Preview](https://mille-hypzm5ss8-fumin1.vercel.app)

- 切替前の再確認で、Vercel の `mille-preview` ストアは Free で接続先0件、Neon の既定は常設用の `main`、残るブランチは `main` と独立した空テンプレート `mille-pr-template` だった。AC-03 の次の確認は、別承認後に旧ジョブを休止し、空テンプレートを一時的に既定にした上で、既存ストアを Preview 限定で接続して試験する。 [Vercel ストア](https://vercel.com/fumin1/~/integrations/neon/icfg_lQa8FrtYd7ppoLmOxnGzOvGf/resources/storage/store_tzb7wMnsJ8PsmiI4/guides) · [切替と復旧手順](https://github.com/tyask/mille/blob/f8c54199e3764a7e6b3c711c64f5991d7f29a85f/docs/pr-preview.md#neon-native-の接続と切替計画)

- 利用者から、既存の `mille-preview` を使った一時的な Native 試験切替の承認を受けた。 `main` の `f8c54199e3764a7e6b3c711c64f5991d7f29a85f` を確認し、開いている PR は0件、#39 の旧管理ジョブによる削除は完了、関連の待機中・実行中ジョブは0件だった。承認範囲は旧ジョブの一時停止、空の `mille-pr-template` の一時的な既定化、既存ストアの Preview 限定接続、試験用 draft PR 2件の実行・削除と元の構成への復旧。現在使える GitHub 接続では Actions 変数を編集できないため、利用者に `MILLE_PR_PREVIEW_ENABLED=false` の保存を依頼した。Vercel のストアは接続先0件、Neon の現在の既定は常設用 `main`。 [GitHub Actions の変数](https://github.com/tyask/mille/settings/variables/actions) · [削除ジョブ](https://github.com/tyask/mille/actions/runs/44913538171/job/136874249311) · [試験切替の手順](https://github.com/tyask/mille/blob/f8c54199e3764a7e6b3c711c64f5991d7f29a85f/docs/pr-preview.md#native-の試験用-db-と削除)

- 利用者が `MILLE_PR_PREVIEW_ENABLED=false` を保存した。最新 `main` の `f8c54199e3764a7e6b3c711c64f5991d7f29a85f` から、識別用の通常ファイル `docs/native-preview-pilot.md` を1件だけ追加した試験用 draft PR A #41（`5d24293c25b406a732f037d1ad1960a19dd8f4e8`）、B #40（`430f107071c90f42881d19a939403019e1693648`）を作成した。準備ログの対象番号と完全 SHA、対応する旧管理ジョブの `skipped`、両管理ワークフローの終了、旧ジョブの待機・実行0件、両PR用のVercelとNeonの専用資源が作成されていないことを確認した。 [試験A #41](https://github.com/tyask/mille/pull/41) · [試験B #40](https://github.com/tyask/mille/pull/40) · [Aの停止確認](https://github.com/tyask/mille/actions/runs/44916222581/job/136882380811) · [Bの停止確認](https://github.com/tyask/mille/actions/runs/44916218568/job/136882377554)

- 切替の承認範囲に沿って、Neon `mille-preview` の既定を空の `mille-pr-template`（`br-winter-butterfly-a1yz5mn8`）に一時変更した。読み取り専用の確認で3データベースが空だった。変更後は同じ2本のルートと2つの endpoint、および同じ常設Vercelデプロイの `READY` を確認した。Marketplaceストアは変更直後に接続先0件。GitHubの試験用変数とVercelのPreview限定接続の保存を利用者に案内した。試験を有効にする前に接続を照合する。 [既存ストア](https://vercel.com/fumin1/~/integrations/neon/icfg_lQa8FrtYd7ppoLmOxnGzOvGf/resources/storage/store_tzb7wMnsJ8PsmiI4/guides) · [試験手順](https://github.com/tyask/mille/blob/f8c54199e3764a7e6b3c711c64f5991d7f29a85f/docs/pr-preview.md#native-の試験用-db-と削除)

- 2026-11-22（JST）の Neon Native 実環境試験で、`main` の `f8c54199e3764a7e6b3c711c64f5991d7f29a85f`、draft A #41 の `5d24293c25b406a732f037d1ad1960a19dd8f4e8`、B #40 の `430f107071c90f42881d19a939403019e1693648` を照合した。旧ジョブ停止中に GitHub の試験用変数7件を保存し、Vercel の既存 `mille-preview` ストア `store_tzb7wMnsJ8PsmiI4` を `fumin1/mille` に接続した。接続 `spc_cO6DakfMdxk2GO9Q` の環境と自動分岐がともに Preview 限定で、`MILLE_NATIVE_PREVIEW_DATABASE_URL` が Sensitive であることを読み戻した。Neon `billowing-cherry-59956184` の既定は空の `mille-pr-template`（`br-winter-butterfly-a1yz5mn8`）で、3データベースの空を読み取りで確認した。 [試験A #41](https://github.com/tyask/mille/pull/41) · [試験B #40](https://github.com/tyask/mille/pull/40) · [対象ストア](https://vercel.com/fumin1/~/integrations/neon/icfg_lQa8FrtYd7ppoLmOxnGzOvGf/resources/storage/store_tzb7wMnsJ8PsmiI4/guides)

- `main` から A の `deploy` を1回実行した。試験変数の一致をログで確認し、準備ジョブは成功した。管理ジョブは「Native Preview の試験用リソース照合・準備・整理」で停止した。Vercel の対象デプロイとエイリアスは見つからず、Neon の一覧・操作履歴に試験ブランチ・endpoint の作成はなかった。デプロイ ID や世代、試験 DB 初期化の証拠は得られず、資格情報の分離・共有は判定できなかった。PC の認証で Git ソース、Git デプロイ設定、初回作成履歴、Vercel の事前照合を読み取りで再現すると成功した。Actions 内の停止箇所はログから特定できなかった。A の再実行を見送り、A の成功を条件とする B の `deploy` は起動しなかった。 [A の管理ジョブ](https://github.com/tyask/mille/actions/runs/44918925724/job/136890555100)

- Native 有効中に試験 PR 2件をクローズした。両方の削除ジョブも同じ工程で停止したため、プロバイダーから専用 Vercel デプロイ・エイリアス、Neon ブランチ・endpoint の不在を直接確認した。管理ジョブによる実資源の削除は未検証。 [A の削除ジョブ](https://github.com/tyask/mille/actions/runs/44919120178/job/136891135425) · [B の削除ジョブ](https://github.com/tyask/mille/actions/runs/44919116031/job/136891111333)

- 試験ジョブを停止し、関連の待機・実行0件を確認後、Vercel の試験接続を解除した。ストアは `available`、接続0件、Native 用環境変数0件。Neon の既定を `main`（`br-dark-rain-a1cc9tfa`）に戻し、常設 endpoint `ep-bitter-wind-a1atj6vn` とテンプレート endpoint `ep-blue-unit-a1yy95c3` の2組だけが残ることを再確認した。GitHub の試験用変数7件を削除し、`MILLE_PR_PREVIEW_ENABLED=true` で旧管理ジョブを再開する設定を読み戻した。常設の同じデプロイ `dpl_PzqN4fUewyF6MtViekWrhWSb5juw` は `READY` で、Chrome に架空 A/B のログイン画面が表示された。 [常設 Preview](https://mille-hypzm5ss8-fumin1.vercel.app)

- AC-03 は保留。Actions の停止箇所の特定、Neon Native の分岐と Vercel が注入する資格情報の PR 間分離、同じ PR の HEAD 更新時のデータ保持、クローズ・マージ時の実資源の削除が残る。現行ジョブの履歴ガードは、作成結果を確認できない A の同一 PR で新規作成を拒否する。 [履歴の照合実装](https://github.com/tyask/mille/blob/f8c54199e3764a7e6b3c711c64f5991d7f29a85f/scripts/preview/native-pilot-history.ts)

### AC-03 の停止箇所を診断する計画

2026-11-22（JST）に、チャットで提示した診断追加の計画について利用者から「承認します」と回答を受けた。

- 目的は、試験 A のデプロイと試験 PR 2 件の削除ジョブが共通して通る照合処理で、Actions が失敗した確認項目を特定できるようにすること。 [試験 A の実行ログ](https://github.com/tyask/mille/actions/runs/44918925724/job/136890555100)

- 信頼済み `main` から手動実行できる読み取り専用診断を追加する。管理ジョブと同じ GitHub Environment `mille-pr-preview` の既存資格情報を使い、旧構成に復旧済みの状態で Vercel と Neon の照合を実行できるようにする。

- 診断の出力は確認項目と、取得できた場合の HTTP 状態に限定する。テストで失敗箇所を識別できること、秘密値・API 応答本文が出力されないこと、資源の作成・削除や DB 初期化が発生しないことを確認する。

- 停止原因の特定と対応後に、新しい試験 PR 2 件で実際に注入された DB 資格情報の分離、HEAD 更新後のデータ保持、クローズ・マージ後の専用資源削除を検証する。AC-03 のチェックは全証拠が揃うまで保留する。

### 診断 PR の検証

- PR #42 の完全 HEAD `9e0eb2fcefc43ce9df1636c885c5dac1132bb946` で読み取り専用診断を実装した。固定 GET と診断出力の抑制を対象テスト33件および独立レビューで確認した。clean checkout の高速検査、全249テスト、build、ブラウザ QA 4件が成功した。GitHub の push・PR CI でも同じソース HEAD の249テストとブラウザ QA 4件が成功した。 [PR #42](https://github.com/tyask/mille/pull/42) · [独立レビュー](https://github.com/tyask/mille/pull/42#issuecomment-7065310208) · [push CI](https://github.com/tyask/mille/actions/runs/44921954702/attempts/1) · [PR CI](https://github.com/tyask/mille/actions/runs/44922143748/attempts/1)

- 初回の正式 Preview 管理ジョブは Vercel 準備工程で停止した。対象の `dpl_5WUV9Q6sdMqgwG9MXx2gAhD3SLQj` は現 HEAD と専用 Neon endpoint に一致して `READY` となり、信頼済み `main` からの再実行で同じデプロイの照合が成功した。 [初回ジョブ](https://github.com/tyask/mille/actions/runs/44922162870/job/136900433483) · [再照合ジョブ](https://github.com/tyask/mille/actions/runs/44922503739/job/136901462585) · [正式 Preview](https://mille-mp822za0p-fumin1.vercel.app)

- 診断の実行は PR #42 の `main` マージ後に行う。AC-03 は当初の停止箇所の特定と実環境試験の証拠が揃うまで保留する。

### PR #42 マージ後の確認と診断

- 利用者の承認を受け、PR #42 を `main` の `3aa0ac3938b5bb6a3979196ec7b0aba62c13d338` にマージした。検証済み PR HEAD `9e0eb2fcefc43ce9df1636c885c5dac1132bb946` と Git のツリーが一致する。main CI 試行1は、この SHA で249テストとブラウザ QA 4件に成功した。 [PR #42](https://github.com/tyask/mille/pull/42) · [main CI](https://github.com/tyask/mille/actions/runs/44977369628/attempts/1) · [QA 成果物](https://github.com/tyask/mille/actions/runs/44977369628/artifacts/14736530732)

- 同一 SHA の本番デプロイ `dpl_y6hCZaT9AKkbAnKqZpprwZKhmhQn` が `READY` となり、既存の本番エイリアス3件がこのデプロイを参照した。Next.js ビルド、既存 DB の照合と移行処理の開始・完了、公開の順序をログで確認した。PR の migration SQL に差分はない。 [本番デプロイ](https://vercel.com/fumin1/mille/y6hCZaT9AKkbAnKqZpprwZKhmhQn)

- 旧方式の #42 cleanup が `main` push とクローズの両方で成功した。Vercel `dpl_5WUV9Q6sdMqgwG9MXx2gAhD3SLQj` の直接取得は HTTP 404、Neon ブランチ `br-young-resonance-a13k87na` と endpoint `ep-broad-sound-a1zevwsd` は一覧から消えた。常設 Preview は従来の `dpl_PzqN4fUewyF6MtViekWrhWSb5juw` で `READY`。 [push の削除](https://github.com/tyask/mille/actions/runs/44977369595/job/137070231057) · [クローズの削除](https://github.com/tyask/mille/actions/runs/44977382670/job/137070286016) · [常設 Preview](https://mille-hypzm5ss8-fumin1.vercel.app)

- 復旧済み構成（Vercel ストアの接続0件、Neon の既定は常設用 `main`）で、同じ `main` SHA の読み取り専用診断を実行した。Actions 環境 `mille-pr-preview` の既存資格情報では、Vercel の対象ストア `store_tzb7wMnsJ8PsmiI4` の GET が HTTP 404。プロジェクト、環境変数メタデータ、デプロイ一覧の先頭ページは HTTP 200、試験 A/B のエイリアスは期待どおり HTTP 404。Neon は先行するストア照合の失敗により未実施。PC の既存認証では同じチームとストアへの GET が成功し、対象が `available` で接続0件であることを確認した。登録済み `VERCEL_TOKEN` の更新時刻は前回 Native 試験より前のままだった。 [診断 試行1](https://github.com/tyask/mille/actions/runs/44977472047/attempts/1) · [診断ジョブ](https://github.com/tyask/mille/actions/runs/44977472047/job/137070482159)

- 前回の Native 管理処理も使うストア取得で、Actions と PC の認証経路に応答の差があると確認した。404 の理由となる権限やスコープは未確定。AC-03 は Actions で対象ストアを照合できることを確認してから、実環境での分岐、資格情報分離、同一 PR 更新時の保持、クローズ・マージ時の削除を検証するまで保留する。

### AC-03 のストア読み取り資格情報を分ける計画

利用者が `fumin1` の期限付き Team スコープの検証用トークンを用意し、対象 Marketplace ストアの読み取り手順の成功を報告した。手順上の成功条件は HTTP 200。Vercel のメタデータで Team スコープと約1時間の期限を照合した。既存のプロジェクト限定トークンを使った Actions 診断では同じストアの GET が HTTP 404 だった。 [前回の診断](https://github.com/tyask/mille/actions/runs/44977472047/job/137070482159)

2026-11-22（JST）に、チャットに提示した資格情報の使い分けの計画に対し、利用者から「承認します」と回答を受けた。

- 目的は、Actions の診断と Native 試験で、承認済み Vercel Marketplace ストアの所有と接続設定を照合できるようにすること。

- GitHub Environment `mille-pr-preview` にストア読み取り用の `VERCEL_NATIVE_PREVIEW_STORE_TOKEN` を用意する設計とする。診断と Native 試験では、検証済みのチームとストア ID を指定する固定 HTTPS GET にだけこの資格情報を使う。その他の Vercel API、デプロイの作成と削除には既存の `VERCEL_TOKEN` を使う。

- テストで、チームトークンを送る先が対象ストアの GET だけであること、未設定や取得拒否で資源を変更する前に停止すること、秘密値を出力しないことを確認する。既存の PR Preview と診断の検証を行う。

- 実装を信頼済み `main` に導入し、復旧済み構成で Actions の読み取り診断を再実行して、ストア取得と後続の Neon 照合を確認する。実際のチーム資格情報の登録と `main` へのマージは対象を示して別途承認を受ける。AC-03 のチェックは実環境試験の証拠が揃うまで保留する。

### ストア読み取り資格情報を分けた PR の検証

- PR #43 の対象 HEAD は `62a6b0a004c2b106efedbe177ea25c6f5828d137`。固定 HTTPS GET に専用の `VERCEL_NATIVE_PREVIEW_STORE_TOKEN` を使い、その他の Vercel API は既存の `VERCEL_TOKEN` を使う。資格情報の欠落・重複・取得拒否で資源変更前に停止することを関連テスト53件で確認した。独立レビューの指摘は0件。 [PR #43](https://github.com/tyask/mille/pull/43) · [独立レビュー](https://github.com/tyask/mille/pull/43#issuecomment-7073692025)

- 同じ HEAD で高速検査、全254テスト、ビルド、架空 A/B のブラウザ QA 4件が成功。push と pull_request の GitHub CI も各254テストとブラウザ QA 4件が成功。pull_request で実際にテストしたコミットは `034e87123c94eaa48bbab001e9728d45e91a36f8`。 [push CI 試行1](https://github.com/tyask/mille/actions/runs/44981326289/attempts/1) · [PR CI 試行1](https://github.com/tyask/mille/actions/runs/44981489560/attempts/1)

- 従来方式の正式 Preview を同じ HEAD で確認。Vercel デプロイは `dpl_EGhuSsCtj9Da2KkhyFs8Es2Uf2De`、Neon ブランチは `br-snowy-wildflower-a19grjap`、エンドポイントは `ep-twilight-credit-a1ahfd3x`。 [正式 Preview の管理ジョブ](https://github.com/tyask/mille/actions/runs/44981500768/job/137082844521)

- 専用シークレットは未登録。マージと期限付き Team 資格情報の登録に対する別承認を受けた後、復旧済み構成で Actions の読み取り診断を再実行する。Native の実分岐、注入された資格情報の分離、同じ PR の更新時のデータ保持、クローズ・マージ時の資源削除が確認できるまで AC-03 を保留する。

### AC-03 の Marketplace API 照合を外し、Cake の方式に揃える計画

2026-11-22（日本時間）に、チャットで提示したこの計画に対し、利用者から「承認します」と回答を受けた。ストア読み取り専用トークンを追加する先の計画は、以下の方針に切り替える。 [PR #43](https://github.com/tyask/mille/pull/43)

- 目的は、Cake と同じく、既存の `VERCEL_TOKEN` と `NEON_API_KEY` で Native Preview の対象を照合できるようにすること。信頼済みの `main` から管理する。 [Cake の照合処理](https://github.com/tyask/Cake/blob/bc737a52701cc3ddf56a17fb947b8c952a379e22/scripts/preview/preview-provider.ts#L41-L49)
- Native 試験ジョブの作成・削除、Actions の読み取り診断、ローカルの切替前確認から Marketplace ストア API とストア・構成・製品 ID の入力を削除する。切替時に、既存ストアの接続先、接続対象環境と自動分岐がそれぞれ Preview 限定であることを Vercel の設定画面で確認する。切替とマージは別途承認の対象とする。
- PR、現在の HEAD、Vercel のプロジェクトとデプロイ、Neon のプロジェクトと親ブランチを照合する。既存の安全停止を使い、静的デプロイへ注入された接続先が当該 PR の専用ブランチ・エンドポイントに一致し、既定・常設・先行試験 PR の接続先と資格情報から分離されていることを確認して DB を初期化する。削除は所有を照合した資源を対象とし、削除後の不在を確認する。
- 既存の資格情報で読み取り診断を完走できることと、接続先・所有が不一致の場合に DB 初期化・削除の前で停止することをテストする。最終 HEAD の独立レビュー、Cloud 検証、CI、従来方式の正式 Preview を確認する。最新 `main` を基点に後継 PR を作成し、PR #43 と相互に関連付けて差し替え、クローズに伴う PR #43 の専用資源の削除を確認する。
- マージ後に復旧済み構成で Actions の診断を行う。Native の実分岐、実際に注入される資格情報の分離、同じ PR の更新時のデータ保持、クローズ・マージ時の専用資源削除を実環境で確認するまで AC-03 は保留する。 [AC-03 の受入条件](https://github.com/tyask/mille/issues/32#受入条件)
