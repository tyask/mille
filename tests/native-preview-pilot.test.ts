import assert from "node:assert/strict";
import test from "node:test";
import { nativePilotPrs, selectPreviewWork } from "../scripts/preview/native-pilot-selection";
import { assertNativePilotSource } from "../scripts/preview/native-pilot-source";
import type { PreviewTarget } from "../scripts/preview/target";

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const controlTree = "c".repeat(40);
const headTree = "d".repeat(40);
const closedAt = "2026-11-21T00:00:00Z";
const deploy = { number: 51, sha: headSha, operation: "deploy" } satisfies PreviewTarget;
const cleanup = { number: 52, sha: headSha, operation: "cleanup", closedAt } satisfies PreviewTarget;
const unrelated = { ...deploy, number: 53 };

test("Native の試験は明示した2件だけを選び、単独の deploy を通知対象にする", () => {
  const pilots = nativePilotPrs("native-pilot", "51,52");
  assert.deepEqual(pilots, [51, 52]);
  assert.throws(() => selectPreviewWork([unrelated, deploy, cleanup], pilots), /1件/);
  assert.deepEqual(selectPreviewWork([unrelated, deploy], pilots), { targets: [deploy], deploy });
  assert.deepEqual(selectPreviewWork([cleanup], pilots), { targets: [cleanup], deploy: undefined });
  assert.deepEqual(selectPreviewWork([unrelated], pilots), { targets: [], deploy: undefined });
});

test("Native の試験は曖昧な対象設定で有効にならない", () => {
  for (const value of [undefined, "", "51", "51,52,53", "51,51", "51, 52", "51,052", "51,0", "51,2147483648"]) {
    assert.throws(() => nativePilotPrs("native-pilot", value), /試験モードまたは対象 PR|異なる2件/, String(value));
  }
  assert.throws(() => nativePilotPrs("native", "51,52"), /試験モード/);
});

test("従来モードでは対象の絞り込みと通知が従来どおり動く", () => {
  for (const mode of [undefined, "", "legacy"]) {
    const pilots = nativePilotPrs(mode, "51,52");
    assert.equal(pilots, undefined);
    assert.deepEqual(selectPreviewWork([unrelated], pilots), { targets: [unrelated], deploy: unrelated });
    assert.deepEqual(selectPreviewWork([cleanup], pilots), { targets: [cleanup], deploy: undefined });
    assert.throws(() => selectPreviewWork([deploy, cleanup], pilots), /1件/);
  }
});

const docs = { path: "docs", type: "tree", mode: "040000", sha: "e".repeat(40) };
const guide = { path: "docs/guide.md", type: "blob", mode: "100644", sha: "f".repeat(40) };
const pkg = { path: "package.json", type: "blob", mode: "100644", sha: "1".repeat(40) };
const marker = { path: "docs/native-preview-pilot.md", type: "blob", mode: "100644", sha: "2".repeat(40) };
const updatedDocs = { ...docs, sha: "3".repeat(40) };
const controlEntries = [docs, guide, pkg];
const headEntries = [updatedDocs, guide, marker, pkg];
const controlTreePath = `git/trees/${controlTree}?recursive=1`;
const headTreePath = `git/trees/${headTree}?recursive=1`;

function github(entries = headEntries, overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [`git/commits/${controlSha}`]: { sha: controlSha, tree: { sha: controlTree } },
    [`git/commits/${headSha}`]: { sha: headSha, tree: { sha: headTree } },
    [controlTreePath]: { sha: controlTree, truncated: false, tree: controlEntries },
    [headTreePath]: { sha: headTree, truncated: false, tree: entries },
    ...overrides,
  };
  const requests: string[] = [];
  return {
    requests,
    async read(path: string) {
      assert.ok(Object.hasOwn(responses, path), path);
      requests.push(path);
      return responses[path];
    },
  };
}

test("信頼済み main に通常ファイルの試験マーカーだけを追加した Git ソースを許可する", async () => {
  const { read, requests } = github();
  await assertNativePilotSource(controlSha, headSha, read);
  assert.deepEqual(requests.sort(), [
    `git/commits/${controlSha}`, `git/commits/${headSha}`, controlTreePath, headTreePath,
  ]);
});

test("試験マーカー以外の変更と通常ファイル以外のマーカーを拒否する", async () => {
  const rejects = [
    ["既存ファイルの変更", [...headEntries.slice(0, -1), { ...pkg, sha: "4".repeat(40) }]],
    ["既存ファイルの削除", headEntries.slice(0, -1)],
    ["既存ファイルのモードの変更", [...headEntries.slice(0, -1), { ...pkg, mode: "100755" }]],
    ["別のファイルの追加", [...headEntries, { ...marker, path: "docs/other.md" }]],
    ["空の Git ツリーの追加", [...headEntries, { ...docs, path: "docs/empty", sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }]],
    ["マーカーの位置の違い", [updatedDocs, guide, { ...marker, path: "native-preview-pilot.md" }, pkg]],
    ["実行可能なマーカー", [updatedDocs, guide, { ...marker, mode: "100755" }, pkg]],
    ["リンクのマーカー", [updatedDocs, guide, { ...marker, mode: "120000" }, pkg]],
    ["サブモジュールのマーカー", [updatedDocs, guide, { ...marker, type: "commit", mode: "160000" }, pkg]],
  ] as const;
  for (const [label, entries] of rejects) {
    await assert.rejects(assertNativePilotSource(controlSha, headSha, github([...entries]).read), /照合できません/, label);
  }
  const { read } = github(headEntries, {
    [controlTreePath]: { sha: controlTree, truncated: false, tree: [...controlEntries, marker] },
  });
  await assert.rejects(assertNativePilotSource(controlSha, headSha, read), /照合できません/);
});

test("切り詰め、重複、ハッシュの不一致がある GitHub の応答を拒否する", async () => {
  const rejects = [
    ["不完全な main ツリー", { [controlTreePath]: { sha: controlTree, truncated: true, tree: controlEntries } }],
    ["不完全な PR ツリー", { [headTreePath]: { sha: headTree, truncated: true, tree: headEntries } }],
    ["PR ツリーのパス重複", { [headTreePath]: { sha: headTree, truncated: false, tree: [...headEntries, guide] } }],
    ["PR ツリー SHA の不一致", { [headTreePath]: { sha: controlTree, truncated: false, tree: headEntries } }],
    ["PR コミット SHA の不一致", { [`git/commits/${headSha}`]: { sha: controlSha, tree: { sha: headTree } } }],
  ] as const;
  for (const [label, overrides] of rejects) {
    await assert.rejects(assertNativePilotSource(controlSha, headSha, github(headEntries, overrides).read), /照合できません/, label);
  }
});
