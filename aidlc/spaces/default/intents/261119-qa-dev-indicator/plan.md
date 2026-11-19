# ブラウザQAの開発用インジケーター設定を修正する計画

診断用PR #10で両Ubuntuにおいて、Next.js開発用インジケーターがログアウトクリックを遮断することを確認した。現行mainを起点に修正用draft PRを作る。

1. `qa:cloud` のローカル起動だけが `disableDevIndicator: true` を指定する。Next子プロセス専用の環境変数を設定し、`next.config.ts` は値が `1` のときだけ `devIndicators: false` を適用する。通常の起動・Preview経路・既存のQA操作と判定を維持する。
2. 一時的なmatrixでUbuntu 24.04と26.04の同一修正を実行する。片方が失敗しても、もう片方を継続する。Runner image、完全SHA、全4ケースを照合する。
3. 両runnerの結果を取得した後、`ci.yml` を基準mainと同一のblobに戻す。修正コードがmatrix時から変更されていないことを確認する。
4. 最終SHAを独立レビューし、通常CIを同SHAで確認する。診断PRと修正PRの結果を追跡できるよう記録する。

アプリの挙動・認証・DB・依存・本番・Vercel設定は修正対象外。
