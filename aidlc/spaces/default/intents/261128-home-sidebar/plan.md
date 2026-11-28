# ホームの左メニューとスマホ用ログインQR

## 承認済みの計画

milleのログイン後ホームを、Cakeと同じように左メニューから操作できる構成にする。

1. ワークスペース切り替えを左メニュー上部に置く。普段は選択中の名前だけを表示し、ドロップダウンを開くと切り替え先が見える。作成ボタンもここにまとめる。
2. 献立・提案・ワークスペース設定の切り替えを左メニューに移す。PCでは左端に常時表示し、スマホでは左上のボタンから同じメニューを開く。
3. スマホでログインするためのQRコードをPCの左メニュー下部に表示する。スマホで読み取ると、PCで開いているのと同じ環境のmilleが開き、スマホ側で通常のログインに進める。

最新の `main` を起点に既存の画面切り替えと選択保存の処理を使う。PC・スマホでの操作、再読み込み後の選択復元、編集中の移動確認、作成・招待・削除、QRの読み取りからログインまでを検証する。

- [承認対象のIssue](https://github.com/tyask/mille/issues/80)
- [Cakeの画面構成](https://github.com/tyask/Cake/blob/main/components/dashboard.tsx#L37-L56)
- [CakeのQR実装](https://github.com/tyask/Cake/blob/main/components/mobile-access-qr.tsx)
