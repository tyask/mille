import { readFile } from "node:fs/promises";
import { resolveManualPreviewTarget, resolveMergedPreviewTargets, resolvePreviewTarget } from "./target";

type GitHubMutation = { method: "POST" | "PATCH"; body: Record<string, unknown> };
export type PreviewGitHubRequest = (path: string, mutation?: GitHubMutation) => Promise<unknown>;

export class PreviewGitHubHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super("GitHub API の照合に失敗しました。");
  }
}

export function previewGitHubHttpStatus(error: unknown): number | undefined {
  if (error instanceof PreviewGitHubHttpError) return error.httpStatus;
  if (error instanceof Error && error.cause instanceof PreviewGitHubHttpError) return error.cause.httpStatus;
  return undefined;
}

export function isTrustedMainWorkflowPath(path: string, workflow: string, sha: string): boolean {
  const [name, ref, ...extra] = path.split("@");
  const file = `.github/workflows/${workflow}`;
  return (name === file || name === `tyask/mille/${file}`) && extra.length === 0
    && (ref === undefined || ref === "main" || ref === "refs/heads/main" || ref === sha);
}

export function previewGitHubRequest(token: string): PreviewGitHubRequest {
  return async (path, mutation) => {
    const response = await fetch(`https://api.github.com/repos/tyask/mille/${path}`, {
      method: mutation?.method,
      body: mutation ? JSON.stringify(mutation.body) : undefined,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(mutation && { "Content-Type": "application/json" }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new PreviewGitHubHttpError(response.status);
    return response.json().catch(() => { throw new PreviewGitHubHttpError(response.status); });
  };
}

export async function previewContext() {
  const { GITHUB_REPOSITORY, GITHUB_REF, GITHUB_WORKFLOW_REF, GITHUB_EVENT_NAME,
    GITHUB_EVENT_PATH, GITHUB_SHA, GH_TOKEN } = process.env;
  if (GITHUB_REPOSITORY !== "tyask/mille" || GITHUB_REF !== "refs/heads/main"
    || GITHUB_WORKFLOW_REF !== "tyask/mille/.github/workflows/pr-preview.yml@refs/heads/main"
    || (GITHUB_EVENT_NAME !== "workflow_run" && GITHUB_EVENT_NAME !== "push" && GITHUB_EVENT_NAME !== "workflow_dispatch")
    || !GITHUB_EVENT_PATH || !GITHUB_SHA || !/^[a-f0-9]{40}$/.test(GITHUB_SHA) || !GH_TOKEN) {
    throw new Error("管理処理の実行元が一致しません。");
  }

  const controlSha = GITHUB_SHA;
  const token = GH_TOKEN;
  const event: unknown = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
  const request = previewGitHubRequest(token);
  const read = (path: string) => request(path);

  async function targets() {
    if (GITHUB_EVENT_NAME === "push") return resolveMergedPreviewTargets(event, controlSha, read);
    const target = GITHUB_EVENT_NAME === "workflow_dispatch"
      ? await resolveManualPreviewTarget(event, read)
      : await resolvePreviewTarget(event, controlSha, read);
    return target ? [target] : [];
  }
  return { read, request, targets, token, controlSha };
}
