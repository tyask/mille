import { z } from "zod";
import type { PreviewGitHubRequest } from "./github";
import { isNativePreviewTaskBranch, milleRepositoryId } from "./native-identity";

export const postMergeRepository = "tyask/mille";
export const postMergeSha = z.string().regex(/^[0-9a-f]{40}$/);
export const postMergeNumber = z.number().int().positive();
export const repositoryIdentity = z.object({
  id: z.literal(milleRepositoryId), full_name: z.literal(postMergeRepository),
});

const metadataPrefix = "<!-- mille-task/v1 ";
const metadata = z.strictObject({
  issue: postMergeNumber,
  intent: z.string().regex(/^aidlc\/spaces\/default\/intents\/[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
  completesIssue: z.boolean(),
  manualPostMerge: z.boolean(),
});

export const mergedTaskSchema = z.strictObject({
  number: postMergeNumber,
  headSha: postMergeSha,
  headRef: z.string().max(240).refine(isNativePreviewTaskBranch),
  mergeSha: postMergeSha,
  mergedAt: z.iso.datetime(),
  metadata,
});
export type MergedTask = z.infer<typeof mergedTaskSchema>;

export function readTaskMetadata(body: string | null) {
  const text = body ?? "";
  const occurrences = text.split(metadataPrefix);
  if (occurrences.length === 1) return undefined;
  const match = /^([^\r\n]{1,500}) -->[ \t]*(?:\r?\n|$)/.exec(occurrences[1]);
  if (occurrences.length !== 2 || (occurrences[0] && !occurrences[0].endsWith("\n")) || !match) {
    throw new Error("案件指定を照合できません。");
  }
  return metadata.parse(JSON.parse(match[1]));
}

export function malformedTaskRefersToIssue(body: string | null, issue: number): boolean {
  const text = body ?? "";
  const number = postMergeNumber.parse(issue);
  return text.includes(metadataPrefix) && (new RegExp(`"issue"\\s*:\\s*${number}(?![0-9])`).test(text)
    || new RegExp(`https://github\\.com/tyask/mille/issues/${number}(?![0-9])`).test(text));
}

const pull = z.object({
  number: postMergeNumber,
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  merged_at: z.iso.datetime().nullable(),
  merge_commit_sha: postMergeSha.nullable(),
  author_association: z.string(),
  head: z.object({ ref: z.string(), sha: postMergeSha, repo: repositoryIdentity }),
  base: z.object({ ref: z.literal("main"), repo: repositoryIdentity }),
});

export async function readMergedTask(read: PreviewGitHubRequest, number: number): Promise<MergedTask | undefined> {
  const raw = await read(`pulls/${postMergeNumber.parse(number)}`);
  const info = z.object({ body: z.string().nullable() }).parse(raw);
  const taskMetadata = readTaskMetadata(info.body);
  if (!taskMetadata) return undefined;

  const pr = pull.parse(raw);
  if (pr.number !== number || pr.state !== "closed" || !pr.merged
    || !["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association)) {
    throw new Error("マージ済みの案件 PR を照合できません。");
  }
  return mergedTaskSchema.parse({
    number, headSha: pr.head.sha, headRef: pr.head.ref, mergeSha: pr.merge_commit_sha,
    mergedAt: pr.merged_at, metadata: taskMetadata,
  });
}

export function sameMergedTask(a: MergedTask, b: MergedTask): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function verifyTaskIntent(read: PreviewGitHubRequest, task: MergedTask) {
  const path = `${task.metadata.intent}/intent.json`;
  const file = z.object({
    path: z.string(), sha: postMergeSha, type: z.literal("file"), encoding: z.literal("base64"), content: z.string().max(30_000),
  }).parse(await read(`contents/${path}?ref=${task.mergeSha}`));
  const intent = z.object({
    issue: z.string(), branch: z.string(), state: z.literal("frozen"),
    postMerge: z.strictObject({ completesIssue: z.boolean(), manualPostMerge: z.boolean() }),
  })
    .parse(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  if (file.path !== path || intent.branch !== task.headRef
    || intent.issue !== `https://github.com/${postMergeRepository}/issues/${task.metadata.issue}`
    || intent.postMerge.completesIssue !== task.metadata.completesIssue
    || intent.postMerge.manualPostMerge !== task.metadata.manualPostMerge) {
    throw new Error("マージ済みの Intent と案件指定が一致しません。");
  }
  const files = await githubPages(read, `pulls/${task.number}/files`,
    z.object({ filename: z.string(), sha: postMergeSha, status: z.string() }));
  const changed = files.filter(item => item.filename === path);
  if (changed.length !== 1 || changed[0].status !== "added" || changed[0].sha !== file.sha) {
    throw new Error("この PR が追加した Intent を照合できません。");
  }
}

export async function readPostMergeMain(read: PreviewGitHubRequest): Promise<string> {
  return z.object({ name: z.literal("main"), commit: z.object({ sha: postMergeSha }) })
    .parse(await read("branches/main")).commit.sha;
}

export async function readPostMergeIssue(read: PreviewGitHubRequest, number: number) {
  const issue = z.object({
    number: postMergeNumber, state: z.enum(["open", "closed"]), body: z.string().nullable(),
    pull_request: z.never().optional(),
  }).parse(await read(`issues/${postMergeNumber.parse(number)}`));
  if (issue.number !== number) throw new Error("案件 Issue を照合できません。");
  return issue;
}

export function acceptanceComplete(body: string | null): boolean {
  const sections = (body ?? "").split(/^## /m).filter(section => /^受入条件[ \t]*\r?\n/.test(section));
  if (sections.length !== 1) return false;
  const checks = sections[0].split(/\r?\n/).filter(line => /^\s*[-*+] \[/.test(line));
  const ids = checks.map(line => /^- \[[xX]\] (AC-[0-9]+):\s+\S/.exec(line)?.[1]);
  return ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length;
}

export async function githubPages<T>(read: PreviewGitHubRequest, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const rows: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 100; page += 1) {
    const result = z.array(schema).max(100).parse(await read(`${path}${separator}per_page=100&page=${page}`));
    rows.push(...result);
    if (result.length < 100) return rows;
  }
  throw new Error("GitHub の一覧を全件照合できません。");
}
