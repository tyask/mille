# 常設 Preview のリリース

既存の常設固有 URL `mille-hypzm5ss8-fumin1.vercel.app` を維持し、`main` と同じコミットの保護付き Preview に固定 URL `mille-main-preview-fumin1.vercel.app` を追加します。DB は現用の Neon `mille-preview` の `main` を使います。 [Issue #32](https://github.com/tyask/mille/issues/32)

**Mille Standing Preview** は `main` の更新で起動し、同じ完全 SHA の CI と本番デプロイの完了を待ちます。初回の固定URL割り当てと再実行は、信頼済み `main` から現在の完全 SHA を指定します。

```sh
gh workflow run standing-preview.yml --repo tyask/mille --ref main -f sha="<最新 main の完全 SHA>"
```

1. GitHub の `main`・CI、Vercel チームとプロジェクト、本番の3エイリアス、既存の常設固有 URL の保護と実行時 SHA、専用 Neon の所有を照合します。常設 DB の marker、接続先、適用済み SQL の番号と SHA-256 を読み取りで確認します。固定 URL がある場合、その配信元の Git 原本を現在の原本と照合し、配信元が必要とする適用履歴の欠落を検出します。接続情報は GitHub の `main` 限定 Environment から処理中に取得し、Vercel の対象デプロイの環境設定に限って渡します。
2. 照合した `main` の Git ツリーを既存 Vercel プロジェクトの保護付き Preview としてビルドし、固有 URL の `READY` を確認します。固定 URL の割り当ては検証後に行います。
3. ビルド後に実行元、接続先、移行履歴を再照合し、同じ Git ツリーに含まれる未適用の連番 SQL を既存の移行ランナーで一括適用します。履歴の先頭を承認済み原本と照合し、将来の連番ファイルも検出します。適用済み SQL のハッシュと適用日時を保持します。移行後の履歴、固有 URL での PC・スマホ × 架空 A/B の4ケース、実行時 SHA、専用 DB の識別子を照合してから固定 URL を割り当てます。
4. 固定 URL のトップと実行時確認 API で、未認証時の Vercel 認証応答を確認します。同じプロジェクトの短期 OIDC を使った実行時 SHA も照合します。割り当て後の確認に失敗した場合は、今回の作成と確認できた割り当てを再照合して取り消します。割り当てが競合した場合は、応答が示した直前の参照先の所有と現在の割り当ての双方が一致するときにだけ元の参照先に戻します。確認できた識別子を使って、停止後の状態を再照合できます。

Actions の Summary と証跡で `main` SHA、CI 試行、デプロイ・Neon・エイリアスの識別子とブラウザ結果を確認できます。追加で適用した移行の件数とファイル名はジョブのログと成功時の Summary に記録します。 [Cake の常設 Preview 処理](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/scripts/preview/staging-workflow.ts) · [Vercel の固定エイリアス](https://vercel.com/docs/rest-api/aliases/assign-an-alias)

## 継続更新

新しいビルド、移行またはブラウザ検証が失敗した場合、固定 URL は直前の版を配信し続けます。移行の SQL と履歴は一括で確定します。移行成功後にリリースが停止した場合は、適用済みの変更が残るため、移行は配信中の版と互換性を保つ必要があります。切り替え後の照合に失敗した場合は、今回の割り当てを確認できた時点で直前の割り当てに戻します。

現在の `main` を対象に再実行すると、対象 SHA の所有済みデプロイと適用済みの履歴を照合します。固定 URL がすでに同じ SHA を指す場合は、移行履歴を読み取りで照合し、アプリのブラウザ検証を再実行します。途中でより新しい `main` が到着した場合は、古い SHA の公開を止めます。 [既存 DB の移行手順](../scripts/db/README.md#cli-を使う場合) · [Mille Standing Preview](https://github.com/tyask/mille/actions/workflows/standing-preview.yml)
