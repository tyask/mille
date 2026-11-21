import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { executeNativePilot } from "../scripts/preview/native-pilot";
import { milleRepositoryId } from "../scripts/preview/native-identity";
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
const deployment: NativePilotDeployment = {
  id: "dpl_Fixture", pr, ref, sha: head, generation: "8a481116-21d6-4dfc-a8ba-32e49289ac28",
  requestedAt: 1795600000000, createdAt: 1795600000010, readyAt: 1795600001000,
  url: "https://mille-test-fumin1.vercel.app", readyState: "READY",
  endpointDigest: createHash("sha256").update(database.host).digest("hex"),
};
const deploy = { operation: "deploy", number: pr, sha: head } as const;
const cleanup = { operation: "cleanup", number: pr, sha: head, closedAt } as const;
const repository = { id: milleRepositoryId, full_name: "tyask/mille" };
const gitPolicy = Buffer.from(JSON.stringify({ git: { deploymentEnabled: { "**": false, main: true } } }));
const configSha = createHash("sha1").update(`blob ${gitPolicy.length}\0`).update(gitPolicy).digest("hex");

function fixture(target: PreviewTarget, options: {
  markerMode?: string;
  existing?: NativePilotDeployment;
  child?: typeof database;
} = {}) {
  const events: string[] = [];
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
    vercel: {
      async preflight() { events.push("vercel preflight"); },
      async find(requested) { return requested.pr === pr ? options.existing ?? null : null; },
      async provision(requested, _generation, verify) {
        assert.deepEqual(requested, { pr, ref, sha: head });
        await verify();
        events.push("provision");
        created = true;
        return deployment;
      },
      async confirmStatic(current) { events.push("static"); return current; },
      async remove(current, verify) {
        await verify();
        events.push("remove deployment");
        assert.equal(current.id, deployment.id);
      },
    },
    neon: {
      async nativePreflight() { events.push("neon preflight"); },
      async assertNativeEndpointAbsent(digest) {
        assert.equal(digest, deployment.endpointDigest);
        events.push("endpoint absent");
      },
      async findNativeBranch(branchRef) { return branchRef === ref ? options.child ?? (created ? database : null) : null; },
      async prepareNativeBranch(_ref, exact, start, number, _standing, peers, verify, end) {
        await verify();
        assert.deepEqual(exact, database);
        assert.equal(start, deployment.requestedAt);
        assert.equal(end, deployment.readyAt);
        assert.equal(number, pr);
        assert.deepEqual(peers, []);
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
  return { input, events, refs };
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

test("Native pilot rejects unreconciled branches and mismatched published endpoint digests", async () => {
  const unknown = fixture(deploy, { child: database });
  await assert.rejects(executeNativePilot(unknown.input), /所有を確認/);
  assert.ok(!unknown.events.includes("provision"));
  const mismatch = fixture(deploy, { existing: { ...deployment, endpointDigest: "e".repeat(64) }, child: database });
  await assert.rejects(executeNativePilot(mismatch.input), /接続先が一致/);
  assert.ok(!mismatch.events.includes("prepare"));
});

test("Native pilot keeps evidence until the exact branch is deleted and refuses an unverified endpoint", async () => {
  const valid = fixture(cleanup, { existing: deployment, child: database });
  assert.equal(await executeNativePilot(valid.input), "removed");
  assert.deepEqual(valid.events.slice(-2), ["remove branch", "remove deployment"]);
  for (const existing of [
    { ...deployment, readyState: "BUILDING" as const },
    { ...deployment, endpointDigest: "e".repeat(64) },
    { ...deployment, readyAt: undefined },
  ]) {
    const unsafe = fixture(cleanup, { existing, child: database });
    await assert.rejects(executeNativePilot(unsafe.input), /終了|接続先|作成期間/);
    assert.ok(!unsafe.events.some(event => event.startsWith("remove")));
  }
});

test("Native pilot proves the attested endpoint is absent even when the branch was already removed", async () => {
  const alreadyRemoved = fixture(cleanup, { existing: deployment });
  assert.equal(await executeNativePilot(alreadyRemoved.input), "removed");
  assert.deepEqual(alreadyRemoved.events.slice(-2), ["endpoint absent", "remove deployment"]);
});
