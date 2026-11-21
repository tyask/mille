import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectNativePreviewSource } from "../scripts/preview/inspect-native";
import { milleRepositoryId } from "../scripts/preview/native-identity";

const controlSha = "a".repeat(40);
const sha = "b".repeat(40);
const number = 35;
const ref = "codex/native-preview-pilot";
const createdAt = "2026-11-21T07:50:00Z";
const repo = { id: milleRepositoryId, full_name: "tyask/mille" };
const target = { operation: "deploy", number, sha } as const;
const pr = {
  number, state: "open", created_at: createdAt, merged: false, closed_at: null, merge_commit_sha: null,
  base: { ref: "main", sha: controlSha, repo },
  head: { ref, sha, repo },
};
const vercel = { buildCommand: "npm run build:vercel", git: { deploymentEnabled: { "**": false, main: true } } };
const npmPackage = { scripts: { "build:vercel": "node --import tsx scripts/build/vercel-build.ts" } };

function files(settings: unknown = vercel, pkg: unknown = npmPackage) {
  return [
    { file: "vercel.json", data: Buffer.from(JSON.stringify(settings)) },
    { file: "package.json", data: Buffer.from(JSON.stringify(pkg)) },
  ];
}

function fixture({
  settings = vercel as unknown, pkg = npmPackage as unknown, laterPr = pr as unknown,
}: { settings?: unknown; pkg?: unknown; laterPr?: unknown } = {}) {
  const source = files(settings, pkg);
  const bytes = source[0].data;
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const response = new Map<string, unknown>([
    [`git/blobs/${blob}`, { sha: blob, size: bytes.length, content: bytes.toString("base64"), encoding: "base64" }],
  ]);
  for (const commit of [controlSha, sha]) {
    const tree = createHash("sha1").update(commit).digest("hex");
    response.set(`git/commits/${commit}`, { sha: commit, tree: { sha: tree } });
    response.set(`git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ type: "blob", path: "vercel.json", mode: "100644", sha: blob }] });
  }
  const events: string[] = [];
  let checks = 0;
  return {
    events,
    controlSha,
    async read(path: string) {
      events.push(path);
      if (path === `pulls/${number}`) return checks++ === 0 ? pr : laterPr;
      assert.ok(response.has(path), path);
      return response.get(path);
    },
    async loadFiles(requested: typeof target) {
      assert.deepEqual(requested, target);
      events.push("read Git objects");
      return source;
    },
  };
}

test("manual inspection returns the exact GitSource after validating both ref snapshots and the build commands", async () => {
  const input = fixture();
  assert.deepEqual(await inspectNativePreviewSource(target, input), {
    number, createdAt, gitSource: { type: "github", repoId: milleRepositoryId, ref, sha },
  });
  assert.equal(input.events[0], `pulls/${number}`);
  assert.ok(input.events.includes(`git/commits/${controlSha}`));
  assert.ok(input.events.includes(`git/commits/${sha}`));
  assert.deepEqual(input.events.slice(-2), ["read Git objects", `pulls/${number}`]);
});

test("manual inspection rejects unsafe Vercel settings and changed npm commands", async () => {
  for (const settings of [
    { ...vercel, buildCommand: "next build" }, { ...vercel, env: { PRIVATE_VALUE: "fixture" } },
    { ...vercel, installCommand: "custom install" }, { ...vercel, outputDirectory: "out" },
  ]) {
    await assert.rejects(inspectNativePreviewSource(target, fixture({ settings })), /Vercel ビルド設定|vercel\.json/);
  }
  for (const pkg of [
    { scripts: { "build:vercel": "next build" } }, { scripts: { ...npmPackage.scripts, "prebuild:vercel": "next build" } },
    { scripts: { ...npmPackage.scripts, "postbuild:vercel": "next build" } },
  ]) {
    await assert.rejects(inspectNativePreviewSource(target, fixture({ pkg })), /npm ビルドコマンド/);
  }
});

test("manual inspection stops when a PR is updated or renamed during source validation", async () => {
  await assert.rejects(inspectNativePreviewSource(target, fixture({
    laterPr: { ...pr, head: { ...pr.head, sha: "c".repeat(40) } },
  })), /PR ソース/);
  await assert.rejects(inspectNativePreviewSource(target, fixture({
    laterPr: { ...pr, head: { ...pr.head, ref: "codex/renamed" } },
  })), /照合中に/);
});
