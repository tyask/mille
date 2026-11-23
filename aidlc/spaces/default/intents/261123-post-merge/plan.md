# 常設 Preview の継続更新とマージ後照合

## 目的・範囲

Issue #32 の AC-05 の継続段階。信頼済み `main` で正式ブラウザ検証を行い、同じ SHA の常設 Preview に固定 URL を割り当てる。初回切替で確保した既存の固有 URL と Neon の常設 DB を使う。Cake と同じく、常設 Preview の更新、マージ後照合、Issue 記録を分ける。

## 受入条件

- 固定 URL は現在の `main` の正式ブラウザ検証成功後に更新する。対象と結果を照合し、切替後の照合に失敗した場合は所有を確認済みの直前の割り当てに復旧する。
- マージ済み PR の HEAD と merge SHA を照合し、同じ merge SHA の main CI、本番デプロイと現行エイリアス、常設 Preview、PR 専用資源削除を証拠に残す。
- 案件の Issue に各 PR の確認結果を保存する。完了指定、関連 PR の追加確認や手動確認待ちの解消、Issue の受入条件すべてを照合してから完了にする。

## 実装と検証方法

既存の常設・PR Preview の管理処理を再利用する。信頼済み `main` の読み取り照合と別ジョブの Issue 記録を組み合わせ、最新 SHA と試行を毎回確認する。正式ブラウザ検証、切替の競合と復旧、対象が変わった証跡、先行 PR や手動確認を残した案件の完了抑止を確認する。正本は別々に承認された元の計画と Issue 本文。凍結後の独立レビュー、合成コミットの CI、正式 Preview と本番/常設の実行結果は PR・Issue に記録する。

基準は [Cake のマージ後手順](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/docs/development-workflow.md#L655-L674) と [Mille の承認済み計画](../261121-cake-parity-ci/plan.md)。
