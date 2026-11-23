# 常設 Preview の初回切替

既存の常設固有 URL `mille-hypzm5ss8-fumin1.vercel.app` を維持し、`main` と同じコミットの保護付き Preview に固定 URL `mille-main-preview-fumin1.vercel.app` を追加します。DB は現用の Neon `mille-preview` の `main` を使います。 [Issue #32](https://github.com/tyask/mille/issues/32)

実行を承認された初回切替では、対象の完全 SHA に対応する `main` CI と本番デプロイの完了後、信頼済み `main` の **Mille Standing Preview** を手動実行します。

```sh
gh workflow run standing-preview.yml --repo tyask/mille --ref main -f sha="<最新 main の完全 SHA>"
```

1. GitHub の `main`・CI、Vercel チームとプロジェクト、本番の3エイリアス、既存の常設固有 URL の保護と実行時 SHA、専用 Neon の所有を照合します。
2. 既存の常設 DB の marker、接続先、適用済みの001・002のハッシュを確認します。未適用の003・004を既存の移行ランナーで適用します。既に完了した移行は履歴を照合します。接続情報は GitHub の `main` 限定 Environment から処理中に取得し、Vercel の対象デプロイの環境設定に限って渡します。
3. 照合した `main` の Git ツリーを既存 Vercel プロジェクトの Preview としてデプロイします。固有 URL で PC・スマホ × 架空 A/B の4ケース、実行時 SHA、専用 DB の識別子を再照合してから固定 URL を割り当てます。
4. 固定 URL のトップと実行時確認 API で、未認証時の Vercel 認証応答を確認します。同じプロジェクトの短期 OIDC を使った実行時 SHA も照合します。割り当て後の確認に失敗した場合は、今回の作成と確認できた割り当てを再照合して取り消します。割り当てが競合した場合は、応答が示した直前の参照先の所有と現在の割り当ての双方が一致するときにだけ元の参照先に戻します。確認できた識別子を使って、停止後の状態を再照合できます。

Actions の Summary と証跡には `main` SHA、CI 試行、デプロイ・Neon・エイリアスの識別子とブラウザ結果を記録します。再実行で固定 URL が同じ SHA の所有済みデプロイに割り当て済みの場合は、その割り当てとアプリを再検証します。処理の途中で終了した場合は、元の固有 URL、移行履歴、新しいデプロイと固定 URL の状態を管理 API で照合してから再実行します。 [Cake の常設 Preview 処理](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/scripts/preview/staging-workflow.ts) · [Vercel の固定エイリアス](https://vercel.com/docs/rest-api/aliases/assign-an-alias)

## 継続更新

`main` に更新があると、**Mille Standing Preview** が同じ SHA の本番公開と CI の確認を待ち、常設 Preview を更新します。新しい固有 URL で正式ブラウザ検証の4ケースと実行時 SHA を確認してから、固定 URL `mille-main-preview-fumin1.vercel.app` を切り替えます。更新後は固定 URL の保護と実行時 SHA を照合します。切替後の照合に失敗した場合は、今回の割り当てを確認できた時点で直前の割り当てに戻し、処理を失敗として記録します。シリアル実行中により新しい `main` が到着した場合は、古い SHA の公開を止めます。

初回切替で確保した固有 URL と Neon の常設ブランチを引き続き使用します。継続更新では承認済みの001〜004の履歴を照合し、新しい SQL や履歴差分がある場合は公開前に停止します。本番や CI の到着が遅れた場合や照合に失敗した場合は、Actions で対象 SHA とジョブの結果を確認します。現在の `main` を対象に、初回切替と同じコマンドで再実行できます。 [Mille Standing Preview](https://github.com/tyask/mille/actions/workflows/standing-preview.yml)
