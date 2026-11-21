import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDocumentation, inspectDocumentation } from "../scripts/tooling/check-docs";

test("documentation checks local Markdown and HTML paths, headings, and explicit repository paths", () => {
  const documents = [
    {
      path: "docs/guide.md",
      content: [
        "[手順](./design%20案.md#開始)",
        "[2件目][ref]",
        "[ref]: <design 案.md#開始-1>",
        "[誤ったリンク](./design%20案.md#不明)",
        "<img src='assets/missing.svg'>",
        "`scripts/missing.mjs`",
        "`/workspace/project/example.ts`",
        "[外部](https://example.com/docs.html#external)",
      ].join("\n"),
    },
    { path: "docs/design 案.md", content: "# 開始\n\n# 開始\n\n[図](screen.html#menu)" },
    { path: "docs/screen.html", content: '<!-- <img src="comment.svg"> --><nav id="menu"></nav>' },
  ];
  assert.deepEqual(
    checkDocumentation(documents, new Set(documents.map(({ path }) => path))),
    [
      { file: "docs/guide.md", line: 4, target: "./design%20案.md#不明", kind: "missing-anchor" },
      { file: "docs/guide.md", line: 5, target: "assets/missing.svg", kind: "missing-file" },
      { file: "docs/guide.md", line: 6, target: "scripts/missing.mjs", kind: "missing-file" },
    ],
  );
});

test("documentation inspection skips generated directories and does not follow symlinked pages", () => {
  const root = mkdtempSync(join(tmpdir(), "mille-docs-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".mille"));
    writeFileSync(join(root, "README.md"), "[文書](docs/source.md#概要)");
    writeFileSync(join(root, "docs", "source.md"), "# 概要");
    writeFileSync(join(root, ".mille", "ignored.md"), "[参照](./missing.md)");
    symlinkSync(join(root, "missing.md"), join(root, "docs", "external.md"));
    assert.deepEqual(inspectDocumentation(root), { documents: 2, issues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
