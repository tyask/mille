import { createHash } from "node:crypto";
import { z } from "zod";

const fullSha = z.string().regex(/^[a-f0-9]{40}$/);
const gitCommit = z.object({ sha: fullSha, tree: z.object({ sha: fullSha }) });
const gitTree = z.object({
  sha: fullSha,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: fullSha })),
});
const configurationFile = z.object({
  encoding: z.literal("base64"),
  size: z.number().int().positive(),
  sha: fullSha,
  content: z.string(),
});
const configuration = z.object({
  git: z.object({
    deploymentEnabled: z.strictObject({
      "**": z.literal(false),
      main: z.literal(true),
    }),
  }),
});

export async function assertPreviewGitDeploymentPolicy(
  controlSha: string,
  headSha: string,
  read: (path: string) => Promise<unknown>,
): Promise<void> {
  if (!fullSha.safeParse(controlSha).success || !fullSha.safeParse(headSha).success) {
    throw new Error("Vercel 設定の照合には main と PR の完全 SHA が必要です。");
  }
  await Promise.all([...new Set([controlSha, headSha])].map(async (commit) => {
    const resolved = gitCommit.safeParse(await read(`git/commits/${commit}`));
    if (!resolved.success || resolved.data.sha !== commit) throw new Error("GitHub 上のコミットを照合できません。");
    const treeSha = resolved.data.tree.sha;
    const tree = gitTree.safeParse(await read(`git/trees/${treeSha}`));
    if (!tree.success || tree.data.sha !== treeSha) throw new Error("GitHub 上のファイル一覧を照合できません。");
    if (tree.data.tree.some(({ path }) => /^(?:now\.json|vercel\.(?:ts|js|mts|mjs|cts|cjs))$/i.test(path))) {
      throw new Error("vercel.json を照合するには、実行形式と旧形式の Vercel 設定を除く必要があります。");
    }
    // Contents API can dereference a symlink. Check the committed mode first.
    const entries = tree.data.tree.filter(({ path }) => path === "vercel.json");
    const entry = entries[0];
    if (entries.length !== 1 || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new Error("GitHub 上の vercel.json が通常ファイルであることを確認できません。");
    }
    const response = configurationFile.safeParse(await read(`git/blobs/${entry.sha}`));
    if (!response.success) throw new Error("GitHub 上の vercel.json を確認できません。");
    const file = response.data;
    const encoded = file.content.replace(/\r?\n/g, "");
    const bytes = Buffer.from(encoded, "base64");
    const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== file.size || bytes.toString("base64") !== encoded || blobSha !== file.sha || blobSha !== entry.sha) {
      throw new Error("GitHub 上の vercel.json の内容を照合できません。");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      throw new Error("vercel.json を UTF-8 の JSON として読み取れません。");
    }
    if (!configuration.safeParse(value).success) {
      throw new Error("vercel.json の Git 自動デプロイ設定が一致しません。");
    }
  }));
}
