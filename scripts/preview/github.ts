import { readFile } from "node:fs/promises";
import { resolveManualPreviewTarget, resolveMergedPreviewTargets, resolvePreviewTarget } from "./target";

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
  async function read(path: string): Promise<unknown> {
    const response = await fetch(`https://api.github.com/repos/tyask/mille/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("GitHub API の照合に失敗しました。");
    return response.json();
  }

  async function targets() {
    if (GITHUB_EVENT_NAME === "push") return resolveMergedPreviewTargets(event, controlSha, read);
    const target = GITHUB_EVENT_NAME === "workflow_dispatch"
      ? await resolveManualPreviewTarget(event, read)
      : await resolvePreviewTarget(event, controlSha, read);
    return target ? [target] : [];
  }
  return { read, targets, token };
}
