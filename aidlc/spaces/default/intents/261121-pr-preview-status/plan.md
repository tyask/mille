# PR に Cake と同じ形式で Preview URL と状態を表示する計画

1. 既存の Preview 管理ジョブから、現行 HEAD と READY を照合したデプロイの ID と保護付き URL を通知用の出力にする。
2. 信頼済みの main で実行する通知ジョブで、PR ごとに Cake と同じ4列のコメントを1件更新し、その HEAD に `mille / Preview` ステータスを設定する。通知ジョブにだけ GitHub の書き込み権限を付ける。
3. PR と実行順序を照合し、追加 push、再実行、古い実行や対象外 PR で表示が壊れないことを回帰テストで確認する。
4. 独立レビューと最終 SHA の検証、draft PR の CI と正式 Preview を確認する。通知が main で有効になった後、確認用の draft PR で実際の表とチェック欄を照合する。
