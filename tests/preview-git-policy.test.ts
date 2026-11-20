import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertPreviewGitDeploymentPolicy } from "../scripts/preview/git-policy";

const main = "1".repeat(40);
const head = "2".repeat(40);
const configuration = { git: { deploymentEnabled: { "**": false, main: true } } };

function snapshot(commitSha: string, bytes: Buffer = Buffer.from(JSON.stringify(configuration))) {
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const treeSha = createHash("sha1").update(commitSha).digest("hex");
  const commit = { sha: commitSha, tree: { sha: treeSha } };
  const tree = {
    sha: treeSha,
    truncated: false,
    tree: [{ type: "blob", path: "vercel.json", mode: "100644", sha }],
  };
  const blob = {
    encoding: "base64",
    size: bytes.length,
    sha,
    content: `${bytes.toString("base64").match(/.{1,60}/g)?.join("\n") ?? ""}\n`,
  };
  return { commit, tree, blob };
}

function readObjects(...snapshots: ReturnType<typeof snapshot>[]) {
  const objects = new Map<string, unknown>(snapshots.flatMap(({ commit, tree, blob }) => [
    [`git/commits/${commit.sha}`, commit],
    [`git/trees/${commit.tree.sha}`, tree],
    [`git/blobs/${tree.tree[0].sha}`, blob],
  ]));
  return async (path: string) => {
    assert.ok(objects.has(path), path);
    return objects.get(path);
  };
}

test("Git 自動デプロイを main に限定する設定を両方の完全 SHA で確認する", async () => {
  const checked: string[] = [];
  const config = await readFile(new URL("../vercel.json", import.meta.url));
  const read = readObjects(snapshot(main, config), snapshot(head, config));
  await assertPreviewGitDeploymentPolicy(main, head, async (path) => {
    checked.push(path);
    return read(path);
  });
  assert.deepEqual(checked.filter((path) => path.startsWith("git/commits/")), [
    `git/commits/${main}`,
    `git/commits/${head}`,
  ]);
});

test("どちらかの設定で Git 自動デプロイが許可された場合は停止する", async () => {
  for (const invalid of [
    { git: { deploymentEnabled: true } },
    { git: { deploymentEnabled: { "**": false, main: true, "codex/*": true } } },
    { git: { deploymentEnabled: { "**": false, main: false } } },
  ]) {
    for (const sha of [main, head]) {
      const bytes = Buffer.from(JSON.stringify(invalid));
      await assert.rejects(
        assertPreviewGitDeploymentPolicy(main, head, readObjects(
          snapshot(main, main === sha ? bytes : undefined),
          snapshot(head, head === sha ? bytes : undefined),
        )),
        /Git 自動デプロイ設定が一致しません/,
      );
    }
  }
});

test("完全 SHA でない ref や通常ファイル以外の設定を拒否する", async () => {
  await assert.rejects(
    assertPreviewGitDeploymentPolicy("main", head, async () => assert.fail("名前で取得しない")),
    /完全 SHA/,
  );
  const valid = snapshot(main);
  const unsafe = snapshot(head);
  for (const entry of [
    { ...unsafe.tree.tree[0], mode: "120000" },
    { ...unsafe.tree.tree[0], path: "other.json" },
  ]) {
    await assert.rejects(
      assertPreviewGitDeploymentPolicy(main, head, readObjects(valid, {
        ...unsafe, tree: { ...unsafe.tree, tree: [entry] },
      })),
      /vercel\.json/,
    );
  }
  await assert.rejects(
    assertPreviewGitDeploymentPolicy(main, head, readObjects(valid, {
      ...unsafe,
      tree: {
        ...unsafe.tree,
        tree: [...unsafe.tree.tree, { ...unsafe.tree.tree[0], path: "vercel.ts" }],
      },
    })),
    /実行形式と旧形式/,
  );
  const treePath = `git/trees/${unsafe.tree.sha}`;
  const read = readObjects(valid, unsafe);
  await assert.rejects(
    assertPreviewGitDeploymentPolicy(main, head, async (path) =>
      path === treePath ? { ...unsafe.tree, truncated: true } : read(path)),
    /ファイル一覧/,
  );
});

test("Git blob の不整合・不正なエンコード・不正な JSON を拒否する", async () => {
  const valid = snapshot(main);
  const unsafe = snapshot(head);
  for (const blob of [
    { ...unsafe.blob, sha: "3".repeat(40) },
    { ...unsafe.blob, size: 1 },
    { ...unsafe.blob, content: `!${unsafe.blob.content}` },
  ]) {
    await assert.rejects(
      assertPreviewGitDeploymentPolicy(main, head, readObjects(valid, { ...unsafe, blob })),
      /vercel\.json/,
    );
  }
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from("{broken")]) {
    await assert.rejects(
      assertPreviewGitDeploymentPolicy(main, head, readObjects(valid, snapshot(head, bytes))),
      /vercel\.json/,
    );
  }
});
