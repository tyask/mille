import { z } from "zod";

const marker = "docs/native-preview-pilot.md";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const failed = () => new Error("Native Preview の試験ソースを信頼済み main と照合できません。");
const commitFormat = z.object({ sha, tree: z.object({ sha }) });
const treeFormat = z.object({
  sha,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string().min(1), mode: z.string(), sha, type: z.enum(["tree", "blob", "commit"]) })),
});

type Read = (path: string) => Promise<unknown>;

async function sourceEntries(commit: string, read: Read) {
  const info = commitFormat.safeParse(await read(`git/commits/${commit}`));
  if (!info.success || info.data.sha !== commit) throw failed();
  const treeSha = info.data.tree.sha;
  const tree = treeFormat.safeParse(await read(`git/trees/${treeSha}?recursive=1`));
  if (!tree.success || tree.data.sha !== treeSha) throw failed();
  const entries = new Map(tree.data.tree.map(entry => [entry.path, entry]));
  if (entries.size !== tree.data.tree.length) throw failed();
  return entries;
}

/** A private Native provisioning deployment may receive credentials before rotation is verified. */
export async function assertNativePilotSource(controlSha: string, headSha: string, read: Read): Promise<void> {
  if (!sha.safeParse(controlSha).success || !sha.safeParse(headSha).success || controlSha === headSha) throw failed();
  const [control, head] = await Promise.all([sourceEntries(controlSha, read), sourceEntries(headSha, read)]);
  const addition = head.get(marker);
  if (control.has(marker) || addition?.type !== "blob" || addition.mode !== "100644" || head.size !== control.size + 1) {
    throw failed();
  }
  const docs = control.get("docs");
  if (docs?.type !== "tree" || docs.mode !== "040000") throw failed();
  for (const [path, entry] of control) {
    const current = head.get(path);
    if (current?.mode !== entry.mode || current.type !== entry.type
      || (path !== "docs" && current.sha !== entry.sha)) throw failed();
  }
}
