import { z } from "zod";
import { isNativePreviewTaskBranch, milleRepositoryId } from "./native-identity";

const repository = "tyask/mille";
const workflow = "actions/workflows/pr-events.yml";
const workflowPath = ".github/workflows/pr-events.yml";
// GitHub can qualify an Actions run path with its repository and ref.
const intakePath = z.string().refine((value) => {
  const [file, ref, ...extra] = value.split("@");
  return (file === workflowPath || file === `${repository}/${workflowPath}`)
    && (ref === undefined || ref.length > 0) && !extra.length;
});
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positive = z.number().int().positive();
const timestamp = z.iso.datetime();
const repositoryRef = z.object({ id: positive, full_name: z.string() });
const branch = z.object({ ref: z.string(), sha, repo: repositoryRef.nullable() });
const pullRequest = z.object({
  number: positive,
  state: z.enum(["open", "closed"]),
  closed_at: timestamp.nullable(),
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  head: branch,
  base: branch,
});
const nativePullRequest = pullRequest.extend({ created_at: timestamp });
const runIdentity = z.object({
  id: positive,
  workflow_id: positive,
  run_attempt: positive,
  event: z.literal("pull_request"),
  path: intakePath,
  repository: repositoryRef,
  head_repository: repositoryRef.nullable(),
  head_branch: z.string(),
  created_at: timestamp,
  display_title: z.string(),
});
const workflowRun = runIdentity.extend({
  status: z.literal("completed"),
  conclusion: z.literal("success"),
  head_sha: sha,
  pull_requests: z.array(z.object({
    number: positive,
    head: z.object({ ref: z.string(), sha, repo: z.object({ id: positive }) }),
    base: z.object({ ref: z.string(), repo: z.object({ id: positive }) }),
  })).nullable().optional(),
});

type ReadGitHub = (path: string) => Promise<unknown>;
export const previewTargetSchema = z.discriminatedUnion("operation", [
  z.object({ number: positive, sha, operation: z.literal("deploy") }),
  z.object({ number: positive, sha, operation: z.literal("cleanup"), closedAt: timestamp }),
]);
export type PreviewTarget = z.infer<typeof previewTargetSchema>;
type PullRequest = z.infer<typeof pullRequest>;

function targetFor(pr: PullRequest): PreviewTarget | null {
  if (pr.base.repo?.full_name !== repository || pr.head.repo?.full_name !== repository
    || pr.head.repo.id !== pr.base.repo.id || pr.base.ref !== "main"
    || !pr.head.ref.startsWith("codex/")) return null;
  if (pr.state === "open") return { number: pr.number, sha: pr.head.sha, operation: "deploy" };
  return pr.closed_at ? { number: pr.number, sha: pr.head.sha, operation: "cleanup", closedAt: pr.closed_at } : null;
}

export function samePreviewTarget(left: PreviewTarget, right: PreviewTarget): boolean {
  return left.number === right.number && left.sha === right.sha
    && (left.operation === "deploy" ? right.operation === "deploy"
      : right.operation === "cleanup" && left.closedAt === right.closedAt);
}

export async function previewTargetIsCurrent(expected: PreviewTarget, read: ReadGitHub): Promise<boolean> {
  const pr = pullRequest.parse(await read(`pulls/${positive.parse(expected.number)}`));
  const target = targetFor(pr);
  return target !== null && samePreviewTarget(target, expected);
}

export async function resolveNativePreviewSource(target: PreviewTarget, read: ReadGitHub) {
  const failure = "Native Preview の PR ソースを照合できません。";
  const expected = previewTargetSchema.safeParse(target);
  if (!expected.success || expected.data.operation !== "deploy") throw new Error(failure);

  let response: unknown;
  try {
    response = await read(`pulls/${expected.data.number}`);
  } catch {
    throw new Error(failure);
  }
  const parsed = nativePullRequest.safeParse(response);
  if (!parsed.success) throw new Error(failure);
  const pr = parsed.data;
  const actual = targetFor(pr);
  const repoId = pr.head.repo?.id;
  if (!actual || !samePreviewTarget(actual, expected.data) || repoId !== milleRepositoryId
    || !isNativePreviewTaskBranch(pr.head.ref)) throw new Error(failure);

  return { number: pr.number, sha: pr.head.sha, ref: pr.head.ref, repoId, createdAt: pr.created_at };
}

function belongsTo(run: z.infer<typeof runIdentity>, id: number): boolean {
  return run.repository.id === id && run.head_repository?.id === id
    && run.repository.full_name === repository && run.head_repository.full_name === repository;
}

export async function resolvePreviewTarget(
  event: unknown, controlSha: string, read: ReadGitHub,
): Promise<PreviewTarget | null> {
  const { repository: eventRepo, workflow_run: notification } = z.object({
    action: z.literal("completed"),
    repository: repositoryRef,
    workflow_run: workflowRun,
  }).parse(event);
  if (eventRepo.full_name !== repository || !belongsTo(notification, eventRepo.id)
    || !notification.head_branch.startsWith("codex/")) return null;

  const registered = z.object({ id: positive, path: z.literal(workflowPath), state: z.literal("active") })
    .parse(await read(workflow));
  const run = workflowRun.parse(await read(`actions/runs/${notification.id}`));
  if (!belongsTo(run, eventRepo.id) || run.id !== notification.id
    || run.run_attempt !== notification.run_attempt || run.created_at !== notification.created_at
    || run.workflow_id !== registered.id || notification.workflow_id !== registered.id
    || run.head_sha !== notification.head_sha || run.head_branch !== notification.head_branch
    || run.display_title !== notification.display_title) return null;

  const title = /^PR event (opened|synchronize|reopened|closed) ([1-9][0-9]*)$/.exec(run.display_title);
  if (!title) return null;
  const number = Number(title[2]);
  if (!Number.isSafeInteger(number)) return null;

  const pr = pullRequest.parse(await read(`pulls/${number}`));
  const target = targetFor(pr);
  const associated = run.pull_requests ?? [];
  if (associated.length > 0) {
    const links = associated.filter((link) => link.number === number);
    const [link] = links;
    if (links.length !== 1 || link.head.ref !== run.head_branch
      || link.head.sha !== pr.head.sha || link.base.ref !== "main"
      || link.head.repo.id !== eventRepo.id || link.base.repo.id !== eventRepo.id) return null;
  }
  const cleanup = title[1] === "closed";
  if (target === null || pr.number !== number || pr.base.repo?.id !== eventRepo.id
    || pr.head.ref !== run.head_branch || (target.operation === "cleanup") !== cleanup) return null;
  if (run.head_sha !== target.sha && !(cleanup && pr.merged && pr.merge_commit_sha === run.head_sha)) return null;
  if (cleanup && (!pr.closed_at || Date.parse(pr.closed_at) > Date.parse(run.created_at))) return null;

  // The run title is usable after the intake definition at the triggering SHA
  // matches the reviewed definition. PRs can modify workflow names and titles.
  const definition = z.object({ sha, type: z.literal("file") });
  const [headDefinition, controlDefinition] = await Promise.all(
    [...new Set([run.head_sha, sha.parse(controlSha)])].map(async (ref) =>
      definition.parse(await read(`contents/${workflowPath}?ref=${ref}`))),
  );
  if (controlDefinition && headDefinition.sha !== controlDefinition.sha) return null;

  // The newest page includes queued runs. With no matching run on that page,
  // or a newer notification for this PR, the current run may be superseded.
  const branchFilter = encodeURIComponent(run.head_branch);
  const page = z.object({
    total_count: z.number().int().nonnegative(),
    workflow_runs: z.array(runIdentity).max(100),
  }).parse(await read(`${workflow}/runs?branch=${branchFilter}&event=pull_request&per_page=100`));
  if (page.workflow_runs.length !== Math.min(page.total_count, 100)) return null;
  const currentRun = page.workflow_runs.find((item) => item.id === run.id);
  if (!currentRun || currentRun.run_attempt !== run.run_attempt) return null;
  const newer = page.workflow_runs.some((item) =>
    item.id > run.id && belongsTo(item, eventRepo.id)
    && item.workflow_id === registered.id && item.head_branch === run.head_branch
    && item.display_title.endsWith(` ${number}`),
  );
  return newer ? null : target;
}

export async function resolveManualPreviewTarget(event: unknown, read: ReadGitHub): Promise<PreviewTarget | null> {
  const { inputs, repository: eventRepo } = z.object({
    repository: repositoryRef,
    inputs: z.object({
      pr: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(positive),
      sha,
      operation: z.enum(["deploy", "cleanup"]),
    }),
  }).parse(event);
  if (eventRepo.full_name !== repository) return null;
  const pr = pullRequest.parse(await read(`pulls/${inputs.pr}`));
  const target = targetFor(pr);
  if (target?.operation !== inputs.operation || target.number !== inputs.pr
    || target.sha !== inputs.sha || pr.base.repo?.id !== eventRepo.id) return null;
  return target;
}

const push = z.object({
  ref: z.literal("refs/heads/main"),
  before: sha,
  after: sha,
  repository: repositoryRef,
  created: z.literal(false),
  deleted: z.literal(false),
  forced: z.literal(false),
});
const maxCommitsPerPush = 100;
const maxCleanupTargets = 10;

export async function resolveMergedPreviewTargets(
  event: unknown, controlSha: string, read: ReadGitHub,
): Promise<PreviewTarget[]> {
  const result = push.safeParse(event);
  if (!result.success) return [];
  const { repository: eventRepo, before, after } = result.data;
  if (eventRepo.full_name !== repository || before === after || after !== sha.parse(controlSha)) return [];

  const compare = z.object({
    status: z.literal("ahead"),
    total_commits: positive,
    merge_base_commit: z.object({ sha }),
    commits: z.array(z.object({ sha })),
  }).parse(await read(`compare/${before}...${after}?per_page=${maxCommitsPerPush}`));
  const commits = compare.commits.map((commit) => commit.sha);
  if (compare.merge_base_commit.sha !== before || commits.at(-1) !== after
    || commits.length !== compare.total_commits || commits.length > maxCommitsPerPush
    || new Set(commits).size !== commits.length) {
    throw new Error("main 更新の全コミットを確認できません。");
  }

  const targets = new Map<number, PreviewTarget>();
  for (let offset = 0; offset < commits.length; offset += 5) {
    const associations = await Promise.all(commits.slice(offset, offset + 5).map(async (commit) => {
      const rows = z.array(z.object({ number: positive, merge_commit_sha: sha.nullable() }))
        .parse(await read(`commits/${commit}/pulls?per_page=100`));
      if (rows.length >= 100) throw new Error("コミットに関連する全 PR を確認できません。");
      return rows.filter((row) => row.merge_commit_sha === commit).map((row) => ({ commit, number: row.number }));
    }));
    for (const { commit, number } of associations.flat()) {
      const pr = pullRequest.parse(await read(`pulls/${number}`));
      const target = targetFor(pr);
      if (target?.operation === "cleanup" && pr.number === number && pr.base.repo?.id === eventRepo.id
        && pr.merged && pr.merge_commit_sha === commit) {
        targets.set(number, target);
        if (targets.size > maxCleanupTargets) throw new Error("main 更新の cleanup 対象が 10 件を超えました。");
      }
    }
  }
  return [...targets.values()];
}
