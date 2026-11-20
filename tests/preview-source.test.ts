import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPreviewTree } from "../scripts/preview/source";

test("PR の Git オブジェクトから元のバイトを取得し、環境とシンボリックリンクを拒否する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mille-source-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory }).toString().trim();
  const commit = () => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "-c", "user.name=Mille Test", "-c", "user.email=mille@example.test", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };

  try {
    git("init", "--quiet", "--template=");
    const binary = Buffer.from([0, 10, 255, 13]);
    await writeFile(join(directory, "データ.bin"), binary);
    await writeFile(join(directory, ".env.example"), "PUBLIC_EXAMPLE=");
    assert.deepEqual(await readPreviewTree(directory, commit()), [{ file: "データ.bin", data: binary }]);

    await writeFile(join(directory, ".env.local"), "DUMMY=value");
    await assert.rejects(readPreviewTree(directory, commit()), /環境ファイル/);
    await rm(join(directory, ".env.local"));
    await symlink("データ.bin", join(directory, "link.bin"));
    await assert.rejects(readPreviewTree(directory, commit()), /通常ファイル以外/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
