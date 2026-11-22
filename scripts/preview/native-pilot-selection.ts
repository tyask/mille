import type { PreviewTarget } from "./target";

/** Only two explicitly selected PRs can use the confidential Native pilot. */
export function nativePilotPrs(mode: string | undefined, value: string | undefined): readonly number[] | undefined {
  if (!mode || mode === "legacy") return undefined;
  if (mode !== "native-pilot" || !/^[1-9][0-9]{0,9},[1-9][0-9]{0,9}$/.test(value ?? "")) {
    throw new Error("Native Preview の試験モードまたは対象 PR の設定が無効です。");
  }
  const numbers = value!.split(",").map(Number);
  if (numbers[0] === numbers[1] || numbers.some(number => number > 2147483647)) {
    throw new Error("Native Preview の試験対象は異なる2件の PR が必要です。");
  }
  return numbers;
}

export function selectPreviewWork(targets: readonly PreviewTarget[], pilots: readonly number[] | undefined) {
  const selected = pilots ? targets.filter(target => pilots.includes(target.number)) : targets;
  const deploy = selected.find(target => target.operation === "deploy");
  // Matrix results can only be used for a notification when a single job owns the output.
  if (deploy && selected.length !== 1) throw new Error("deploy の対象を1件に絞れませんでした。");
  return { targets: selected, deploy };
}
