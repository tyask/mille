# 現 HEAD の正式 Preview を Ready 条件に加える

[Issue #32](https://github.com/tyask/mille/issues/32) の AC-04 を対象に、既存の [承認済み全体計画](../261121-cake-parity-ci/plan.md)、[保存済み Issue](../261121-cake-parity-ci/issue.md)、[別々の承認記録](../261121-cake-parity-ci/approvals.json) と [AC-04 導入計画](../261123-preview-verification/plan.md) を参照する。

[PR #63](https://github.com/tyask/mille/pull/63) をマージした `main` `17a20807ec34f4e00ead035f3fb98fc86052f3b8` から、開いていた #64 の現 HEAD `6d121ce79f2f5b79f1b60094d2468f36c6ce6f41` を照合した。状態確認と正式ブラウザ検証の証跡は PR・HEAD・デプロイ・専用 DB が一致し、PC・スマホ × 架空 A/B の4ケースに成功した。 [status 試行1](https://github.com/tyask/mille/actions/runs/45045837808/attempts/1) · [verify 試行1](https://github.com/tyask/mille/actions/runs/45045976568/attempts/1)

Ready 前に、同一 HEAD の独立レビュー、Cloud 検証、最新の push・pull_request CI、正式 Preview の状態証跡を照合する手順を適用する。アプリ動作を変更する場合は、同じ対象の正式ブラウザ検証と変更箇所の証拠を確認する。Ready 後の追修正では先に draft に戻し、新 HEAD を同じ手順で検証する。AGENTS、開発手順、PR テンプレートを正本に揃える。 [Cake の実運用](https://github.com/tyask/Cake/blob/5975e5f20d9eb755d991b8725840feab0b778d65/docs/development-workflow.md#L569-L615)

文書と手順の整合を自己レビューし、凍結後の完全 SHA で独立レビュー、check:fast、全テスト、build、ローカルブラウザ QA、GitHub CI、現 HEAD の正式 Preview と `status` を確認する。正式ブラウザ `verify` の導入時の実測は上記の #64 の証跡を使う。
