# Native 静的ビルドと専用エイリアスの照合

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-03 の [承認済み計画](../261122-native-preview-completion/plan.md) と [承認記録](../261122-native-preview-completion/approvals.json) を引き継ぐ。

試験 A #51 では Vercel の作成要求が HTTP 200 で受理され、Git ソースに対応する非公開デプロイと Neon の専用ブランチ・endpoint が作られた。Vercel 管理 API に静的出力の一覧と照合用ヘッダーがなく、管理ジョブは DB 初期化前に停止した。保護付きの実応答と Neon の endpoint を照合し、個別に試験専用資源を削除して旧構成に復旧した。 [試験 A](https://github.com/tyask/mille/actions/runs/44994751282/job/137123347906) · [復旧診断](https://github.com/tyask/mille/actions/runs/44995529508/job/137125623305)

Cake に沿って、照合済みの Git ソースから静的ファイルを生成し、所有する非公開デプロイの READY を確認してから専用ブランチの準備に進む。準備用ビルドは出力の照合後にデプロイ・PR・ref・HEAD・世代・endpoint の識別子を出力する。管理ジョブは Vercel の公式ビルドイベントから一意の記録を取得し、今回と比較先の専用接続先の証拠に使う。所有を確認した生成済みのエイリアスは、試験デプロイを削除する前に解除する。 [Cake のデプロイ処理](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/scripts/preview/preview-service.ts#L71-L96) · [Vercel ビルドイベント API](https://vercel.com/docs/rest-api/deployments/get-deployment-events) · [エイリアス削除 API](https://vercel.com/docs/rest-api/aliases/delete-an-alias)

ビルドが拒否された場合や静的出力が書けない場合の発行停止、イベントの所有・識別子・一意性、資格情報比較と削除の前の endpoint 照合、別デプロイのエイリアスを保持する動作をテストする。最終 HEAD の独立レビュー、Cloud 検証、CI、旧管理の正式 Preview を確認する。再試験のマージと一時切替は別途承認を得る。AC-03 は資格情報の分離、アプリ公開、同じ PR のデータ保持、クローズ・マージ後の自動削除を確認するまで保留する。
