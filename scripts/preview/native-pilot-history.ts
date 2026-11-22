import { z } from "zod";

const paginationLimit = 100;
const workflow = "actions/workflows/pr-preview.yml";
const run = z.object({ id: z.int().positive(), run_number: z.int().positive() });
const job = z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullish() });
const runs = z.object({ total_count: z.int().nonnegative(), workflow_runs: z.array(run).max(paginationLimit) });
const jobs = z.object({ total_count: z.int().nonnegative(), jobs: z.array(job).max(paginationLimit) });
const unstarted = new Set(["queued", "waiting", "pending", "requested"]);
const unknown = () => new Error("Native Preview の以前の作成結果を確認できません。既存デプロイを照合してください。");

export async function assertNativePilotFirstCreation(
  pr: number, createdAt: string, environment: Readonly<Record<string, string | undefined>>, read: (path: string) => Promise<unknown>,
): Promise<void> {
  return assertNoEarlierCreation(pr, createdAt, environment, read);
}

export async function assertNativePilotApplicationCreation(
  pr: number, sha: string, createdAt: string,
  environment: Readonly<Record<string, string | undefined>>, read: (path: string) => Promise<unknown>,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw unknown();
  return assertNoEarlierCreation(pr, createdAt, environment, read, sha);
}

async function assertNoEarlierCreation(
  pr: number, createdAt: string, environment: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<unknown>, sha?: string,
): Promise<void> {
  const current = run.safeParse({ id: Number(environment.GITHUB_RUN_ID), run_number: Number(environment.GITHUB_RUN_NUMBER) });
  if (!current.success || environment.GITHUB_RUN_ATTEMPT !== "1") throw unknown();
  const query = new URLSearchParams({ branch: "main", created: `>=${createdAt}`, per_page: String(paginationLimit) });
  const history = runs.safeParse(await read(`${workflow}/runs?${query}`));
  if (!history.success || history.data.total_count !== history.data.workflow_runs.length
    || !history.data.workflow_runs.some(item => item.id === current.data.id && item.run_number === current.data.run_number)) {
    throw unknown();
  }
  // A later run can acquire the pilot lock first if its preparation finishes sooner.
  const oldName = `PR ${pr} deploy`;
  const nativeName = new RegExp(`^PR ${pr} deploy \\[([a-f0-9]{40})\\]$`);
  const targetsDeployment = (name: string) => {
    if (name === oldName) return true;
    const match = nativeName.exec(name);
    return !!match && (sha === undefined || sha === match[1]);
  };
  for (const item of history.data.workflow_runs.filter(item => item.id !== current.data.id)) {
    const past = jobs.safeParse(await read(`actions/runs/${item.id}/jobs?filter=all&per_page=${paginationLimit}`));
    if (!past.success || past.data.total_count !== past.data.jobs.length
      || past.data.jobs.some(item => targetsDeployment(item.name)
        && item.conclusion !== "skipped" && !unstarted.has(item.status))) {
      throw unknown();
    }
  }
}
