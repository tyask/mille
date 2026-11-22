import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PreviewGitHubHttpError, previewGitHubHttpStatus } from "../scripts/preview/github";
import { executeNativePilot, nativePilotProviders } from "../scripts/preview/native-pilot";
import { milleRepositoryId } from "../scripts/preview/native-identity";
import { assertNativePilotFirstCreation } from "../scripts/preview/native-pilot-history";
import { formatNativePilotFailure, NativePilotStageError } from "../scripts/preview/native-pilot-diagnostics";
import type { NativePilotDeployment } from "../scripts/preview/native-pilot-vercel";
import type { PreviewTarget } from "../scripts/preview/target";

const head = "b".repeat(40);
const control = "a".repeat(40);
const controlTree = "1".repeat(40);
const headTree = "2".repeat(40);
const pr = 41;
const peer = 42;
const ref = "codex/native-preview-pilot-a";
const peerRef = "codex/native-preview-pilot-b";
const closedAt = "2026-11-25T14:00:00Z";
const database = { id: "br-test", endpointId: "ep-test", host: "ep-test.ap-southeast-1.aws.neon.tech" };
const peerDatabase = { id: "br-peer", endpointId: "ep-peer", host: "ep-peer.ap-southeast-1.aws.neon.tech" };
const deployment: NativePilotDeployment = {
  id: "dpl_Fixture", pr, ref, sha: head, generation: "8a481116-21d6-4dfc-a8ba-32e49289ac28",
  requestedAt: 1795600000000, createdAt: 1795600000010, readyAt: 1795600001000,
  url: "https://mille-test-fumin1.vercel.app", readyState: "READY",
};
const peerDeployment: NativePilotDeployment = {
  ...deployment, id: "dpl_Peer", pr: peer, ref: peerRef, sha: "c".repeat(40),
};
const deploy = { operation: "deploy", number: pr, sha: head } as const;
const cleanup = { operation: "cleanup", number: pr, sha: head, closedAt } as const;
const repository = { id: milleRepositoryId, full_name: "tyask/mille" };
const gitPolicy = Buffer.from(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } }));
const configSha = createHash("sha1").update(`blob ${gitPolicy.length}\0`).update(gitPolicy).digest("hex");

test("Native pilot configures the Vercel provider with the existing project credentials", () => {
  const providers = nativePilotProviders({
    NODE_ENV: "test",
    MILLE_NATIVE_PREVIEW_NEON_STANDING_BRANCH_ID: "br-standing",
    MILLE_NATIVE_PREVIEW_NEON_STANDING_ENDPOINT_ID: "ep-standing",
  }, { token: "vercel-test-token", teamId: "team_Fixture", projectId: "prj_Fixture" });
  assert.equal(providers.standingBranchId, "br-standing");
  assert.equal(providers.standingEndpointId, "ep-standing");
});

function fixture(target: PreviewTarget, options: {
  markerMode?: string;
  existing?: NativePilotDeployment;
  child?: typeof database;
  buildEndpointId?: string;
  peerExists?: boolean;
  peerBuildEndpointId?: string;
} = {}) {
  const events: string[] = [];
  const verifiedBuilds: NativePilotDeployment[] = [];
  let created = false;
  const refs = new Map([[pr, ref], [peer, peerRef]]);
  const git = new Map([
    [`git/commits/${control}`, { sha: control, tree: { sha: controlTree } }],
    [`git/commits/${head}`, { sha: head, tree: { sha: headTree } }],
    [`git/blobs/${configSha}`, { sha: configSha, encoding: "base64", size: gitPolicy.length, content: gitPolicy.toString("base64") }],
  ]);
  const entries = [{ path: "vercel.json", sha: configSha, mode: "100644", type: "blob" }];
  async function read(path: string) {
    if (git.has(path)) return git.get(path);
    if (path.startsWith("pulls/")) {
      const number = Number(path.split("/")[1]);
      const closed = number === pr && target.operation === "cleanup";
      return {
        number, state: closed ? "closed" : "open", merged: false, closed_at: closed ? closedAt : null,
        merge_commit_sha: null, created_at: "2026-11-25T13:00:00Z",
        base: { ref: "main", sha: control, repo: repository },
        head: { ref: refs.get(number), sha: head, repo: repository },
      };
    }
    const tree = path.endsWith("?recursive=1");
    const value = path.includes(controlTree) ? controlTree : headTree;
    assert.ok(path.startsWith("git/trees/"));
    const extras = tree ? [{ path: "docs", mode: "040000", type: "tree", sha: value }] : [];
    if (tree && value === headTree) extras.push({
      path: "docs/native-preview-pilot.md", mode: options.markerMode ?? "100644", type: "blob", sha: "3".repeat(40),
    });
    return { sha: value, tree: [...entries, ...extras], truncated: false };
  }
  const input: Parameters<typeof executeNativePilot>[0] = {
    target, controlSha: control, pilotPrs: [pr, peer], read,
    standingBranchId: "br-standing", standingEndpointId: "ep-standing",
    async verifyFirstCreation(number) { assert.equal(number, pr); },
    vercel: {
      async preflight() { events.push("vercel preflight"); },
      async find(requested, exactSha) {
        if (requested.pr === pr) return options.existing ?? null;
        assert.equal(exactSha, false);
        return options.peerExists ? peerDeployment : null;
      },
      async provision(requested, _generation, verify) {
        assert.deepEqual(requested, { pr, ref, sha: head });
        await verify();
        events.push("provision");
        created = true;
        return deployment;
      },
      async confirmStatic(current, verify) {
        await verify?.();
        events.push("static");
        verifiedBuilds.push(current);
        const endpointId = current.pr === pr
          ? options.buildEndpointId ?? database.endpointId
          : options.peerBuildEndpointId ?? peerDatabase.endpointId;
        return { ...current, endpointId };
      },
      async remove(current, verify) {
        await verify();
        events.push("remove deployment");
        assert.equal(current.id, deployment.id);
      },
    },
    neon: {
      async nativePreflight() { events.push("neon preflight"); },
      async findNativeBranch(branchRef) {
        if (branchRef === ref) return options.child ?? (created ? database : null);
        return options.peerExists ? peerDatabase : null;
      },
      async prepareNativeBranch(_ref, exact, start, number, _standing, peers, verify, end) {
        await verify();
        assert.deepEqual(exact, database);
        assert.equal(start, deployment.requestedAt);
        assert.equal(end, deployment.readyAt);
        assert.equal(number, pr);
        assert.deepEqual(peers, options.peerExists ? [{ ref: peerRef, branch: peerDatabase }] : []);
        events.push("prepare");
      },
      async removeNativeBranch(_ref, exact, start, verify, end) {
        await verify();
        assert.deepEqual(exact, database);
        assert.equal(start, deployment.requestedAt);
        assert.equal(end, deployment.readyAt);
        events.push("remove branch");
      },
    },
  };
  return { input, events, refs, verifiedBuilds };
}

test("Native pilot prepares a branch only after matching trusted source, receipt, static output and injected endpoint", async () => {
  const { input, events } = fixture(deploy);
  assert.equal(await executeNativePilot(input), "prepared");
  assert.deepEqual(events, ["vercel preflight", "neon preflight", "provision", "static", "prepare"]);
});

test("Native pilot makes no provider change for unsafe source or shared Git ref", async () => {
  const unsafe = fixture(deploy, { markerMode: "120000" });
  await assert.rejects(executeNativePilot(unsafe.input), /試験ソース/);
  assert.deepEqual(unsafe.events, []);
  const reused = fixture(deploy);
  reused.refs.set(peer, ref);
  await assert.rejects(executeNativePilot(reused.input), /Git ブランチ/);
  assert.deepEqual(reused.events, []);
});

test("Native pilot stops before creating, initializing or deleting resources when project binding fails", async () => {
  for (const { input, events } of [fixture(deploy), fixture(cleanup, { existing: deployment, child: database })]) {
    input.vercel.preflight = async () => { throw new Error("project binding"); };
    await assert.rejects(executeNativePilot(input), /project binding/);
    assert.deepEqual(events, ["neon preflight"]);
  }
});

test("Native pilot rejects unreconciled branches and mismatched build endpoint IDs", async () => {
  const unknown = fixture(deploy, { child: database });
  await assert.rejects(executeNativePilot(unknown.input), /所有を確認/);
  assert.ok(!unknown.events.includes("provision"));
  const mismatch = fixture(deploy, { existing: deployment, child: database, buildEndpointId: "ep-other" });
  await assert.rejects(executeNativePilot(mismatch.input), /接続先が一致/);
  assert.ok(!mismatch.events.includes("prepare"));
});

test("Native pilot checks a peer's actual deployed SHA and endpoint before initializing", async () => {
  const valid = fixture(deploy, { peerExists: true });
  assert.equal(await executeNativePilot(valid.input), "prepared");
  assert.deepEqual(valid.verifiedBuilds.map(item => item.sha), [head, peerDeployment.sha]);

  const mismatch = fixture(deploy, { peerExists: true, peerBuildEndpointId: "ep-other" });
  await assert.rejects(executeNativePilot(mismatch.input), /接続先が一致/);
  assert.ok(!mismatch.events.includes("prepare"));
});

test("Native pilot keeps evidence until the exact branch is deleted and refuses an unverified endpoint", async () => {
  const valid = fixture(cleanup, { existing: deployment, child: database });
  assert.equal(await executeNativePilot(valid.input), "removed");
  assert.deepEqual(valid.events.slice(-3), ["static", "remove branch", "remove deployment"]);
  for (const existing of [
    { ...deployment, readyState: "BUILDING" as const },
    { ...deployment, readyAt: undefined },
  ]) {
    const unsafe = fixture(cleanup, { existing, child: database });
    await assert.rejects(executeNativePilot(unsafe.input), /終了|作成期間/);
    assert.ok(!unsafe.events.some(event => event.startsWith("remove")));
  }
  const mismatch = fixture(cleanup, { existing: deployment, child: database, buildEndpointId: "ep-other" });
  await assert.rejects(executeNativePilot(mismatch.input), /接続先が一致/);
  assert.ok(!mismatch.events.some(event => event.startsWith("remove")));
});

test("Native pilot retains its receipt if it cannot directly prove deletion after an interrupted earlier attempt", async () => {
  const alreadyRemoved = fixture(cleanup, { existing: deployment });
  await assert.rejects(executeNativePilot(alreadyRemoved.input), /直接確認できません/);
  assert.ok(!alreadyRemoved.events.some(event => event.startsWith("remove")));
});

test("Native pilot never creates another deployment after an unknown previous creation", async () => {
  const prior = fixture(deploy);
  prior.input.verifyFirstCreation = async () => { throw new Error("unknown creation"); };
  await assert.rejects(executeNativePilot(prior.input), /unknown creation/);
  assert.ok(!prior.events.includes("provision"));
});

test("Native pilot reports the fixed history stage and HTTP status before making any deployment request", async () => {
  const { input, events } = fixture(deploy);
  const secret = "fixture-secret-must-not-be-logged";
  const cause = new PreviewGitHubHttpError(403);
  cause.message = secret;
  input.verifyFirstCreation = async () => { throw cause; };
  await assert.rejects(executeNativePilot(input), (error: unknown) => {
    assert.ok(error instanceof NativePilotStageError);
    assert.equal(error.cause, cause);
    assert.equal(formatNativePilotFailure(error, previewGitHubHttpStatus(error.cause)),
      "Native Preview 診断 GitHub の初回作成履歴の照合 (HTTP 403)");
    return true;
  });
  assert.deepEqual(events, ["vercel preflight", "neon preflight"]);
});

test("Native pilot keeps the HTTP status when reporting a GitHub PR lookup failure", async () => {
  const { input, events } = fixture(deploy);
  input.read = async () => { throw new PreviewGitHubHttpError(404); };
  await assert.rejects(executeNativePilot(input), (error: unknown) => {
    assert.ok(error instanceof NativePilotStageError);
    assert.equal(error.message, "Native Preview の PR ソースを照合できません。");
    assert.equal(formatNativePilotFailure(error, previewGitHubHttpStatus(error.cause)),
      "Native Preview 診断 GitHub の試験 PR・HEAD 照合 (HTTP 404)");
    return true;
  });
  assert.deepEqual(events, []);
});

test("Native management logs an early GitHub denial before any provider request", () => {
  const directory = mkdtempSync(join(tmpdir(), "mille-native-diagnostic-"));
  try {
    const eventPath = join(directory, "event.json");
    writeFileSync(eventPath, JSON.stringify({ repository, inputs: { pr: String(pr), sha: head, operation: "deploy" } }));
    const responseSecret = "fixture-github-response-secret";
    const mock = `globalThis.fetch = async (input) => {
      if (String(input) !== "https://api.github.com/repos/tyask/mille/pulls/${pr}") {
        throw new Error("unexpected fixture request");
      }
      return Response.json({ message: "${responseSecret}" }, { status: 403 });
    };`;
    const preload = `data:text/javascript;base64,${Buffer.from(mock).toString("base64")}`;
    const execution = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, "scripts/preview/manage.ts"], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 15_000,
      env: {
        ...process.env, GITHUB_REPOSITORY: repository.full_name, GITHUB_REF: "refs/heads/main", GITHUB_SHA: control,
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
        GITHUB_WORKFLOW_REF: "tyask/mille/.github/workflows/pr-preview.yml@refs/heads/main", GH_TOKEN: "fixture-token",
        MILLE_PR_PREVIEW_MODE: "native-pilot", MILLE_PR_PREVIEW_TARGET: JSON.stringify(deploy),
      },
    });
    assert.ifError(execution.error);
    assert.equal(execution.status, 1);
    assert.match(execution.stderr, /Native Preview 診断 GitHub の試験 PR・HEAD 照合 \(HTTP 403\)/);
    assert.doesNotMatch(execution.stdout + execution.stderr, /fixture-github-response-secret|fixture-token|作成要求/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Native pilot preserves the precise template stage without exposing exception contents", async () => {
  const { input, events } = fixture(deploy);
  input.neon.nativePreflight = async () => {
    throw new NativePilotStageError("neon-template-sql", new Error("fixture-secret including HTTP 403"));
  };
  await assert.rejects(executeNativePilot(input), (error: unknown) => {
    assert.ok(error instanceof NativePilotStageError);
    assert.equal(formatNativePilotFailure(error), "Native Preview 診断 Neon のテンプレート空状態の読み取り");
    return true;
  });
  assert.deepEqual(events, ["vercel preflight"]);
});

test("Native pilot uses complete prior workflow history before issuing a first create", async () => {
  const actionsEnv = { GITHUB_RUN_ID: "500", GITHUB_RUN_NUMBER: "50", GITHUB_RUN_ATTEMPT: "1" };
  const createdAt = "2026-11-25T13:00:00Z";
  const history = {
    total_count: 3, workflow_runs: [{ id: 500, run_number: 50 }, { id: 499, run_number: 49 }, { id: 501, run_number: 51 }],
  };
  let conclusion: string | null = "skipped";
  let newerJobStatus = "queued";
  const checked: string[] = [];
  const read = async (path: string) => {
    checked.push(path);
    if (path.startsWith("actions/workflows/pr-preview.yml/runs?")) {
      const params = new URLSearchParams(path.split("?")[1]);
      assert.equal(params.get("created"), `>=${createdAt}`);
      assert.equal(params.get("branch"), "main");
      return history;
    }
    if (path === "actions/runs/501/jobs?filter=all&per_page=100") {
      return { total_count: 1, jobs: [{ name: "PR 41 deploy", status: newerJobStatus, conclusion: null }] };
    }
    assert.equal(path, "actions/runs/499/jobs?filter=all&per_page=100");
    return { total_count: 1, jobs: [{ name: "PR 41 deploy", status: "completed", conclusion }] };
  };
  await assertNativePilotFirstCreation(pr, createdAt, actionsEnv, read);
  assert.equal(checked.length, 3);
  conclusion = "failure";
  await assert.rejects(assertNativePilotFirstCreation(pr, createdAt, actionsEnv, read), /以前の作成結果/);
  conclusion = null;
  await assert.rejects(assertNativePilotFirstCreation(pr, createdAt, actionsEnv, read), /以前の作成結果/);
  conclusion = "skipped";
  newerJobStatus = "completed";
  await assert.rejects(assertNativePilotFirstCreation(pr, createdAt, actionsEnv, read), /以前の作成結果/);
  await assert.rejects(assertNativePilotFirstCreation(pr, createdAt, { ...actionsEnv, GITHUB_RUN_ATTEMPT: "2" },
    async () => assert.fail("a retry with no receipt must stop immediately")), /以前の作成結果/);
  await assert.rejects(assertNativePilotFirstCreation(pr, createdAt, actionsEnv,
    async () => ({ ...history, total_count: 103 })), /以前の作成結果/);
});
