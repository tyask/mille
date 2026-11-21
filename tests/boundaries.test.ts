import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { checkBoundaries } from "../scripts/check-boundaries.mjs";

async function fixture(t: TestContext, sources: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "mille-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: {
      module: "esnext", moduleResolution: "bundler", allowJs: true, paths: { "@/*": ["./*"] },
    } }),
    ...sources,
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return checkBoundaries(root);
}

test("dependency boundaries allow type-only imports and Next server-to-client composition", async t => {
  const violations = await fixture(t, {
    "app/page.tsx": `import "@/auth"; import "@/components/entry"; import "./style.css";`,
    "app/style.css": "",
    "auth.ts": `import "@/lib/server/auth";`,
    "components/entry.tsx": `"use strict"; "use client";
      import "next-auth/react"; import "@/lib/shared/schema.js"; import type { User } from "@/lib/server/auth";
      export { type User } from "@/lib/server/auth";`,
    "lib/shared/schema.ts": `import "zod"; import { type User } from "../server/auth";`,
    "lib/server/auth.ts": `import "node:crypto"; export type User = object;`,
  });
  assert.deepEqual(violations, []);
});

test("dependency boundaries follow aliases, index re-exports and runtime imports", async t => {
  const violations = await fixture(t, {
    "app/page.tsx": `"use client"; export * from "@/components/bridge";`,
    "app/api/example/route.ts": `export * from "@/scripts/fixture.mjs";`,
    "components/bridge/index.tsx": `import("../../lib/server/database");`,
    "lib/server/database.ts": `import "@/components/view";`,
    "components/view.tsx": "export const value = true;",
    "lib/shared/schema.ts": `require("node:fs");`,
    "lib/shared/dynamic.ts": `const source = "./schema"; import(source);`,
    "scripts/fixture.mjs": "export const fixture = true;",
  });
  const report = violations.join("\n");
  assert.match(report, /app\/page.tsx → components\/bridge\/index.tsx → lib\/server\/database.ts/);
  assert.match(report, /lib\/server\/database.ts → components\/view.tsx/);
  assert.match(report, /app\/api\/example\/route.ts:1: .*scripts\/fixture.mjs/);
  assert.match(report, /lib\/shared\/schema.ts:1: .*node:fs/);
  assert.match(report, /lib\/shared\/dynamic.ts:1: .*文字列リテラル/);
});
