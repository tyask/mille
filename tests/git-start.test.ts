import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { dependencyStatus, syncDependencies } from "../scripts/cloud/dependencies.mjs";
import { startTask } from "../scripts/task/start.mjs";

type Fixture = ReturnType<typeof fixture>;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "mille git start "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  mkdirSync(home);
  const environment = {
    NODE_ENV: "test" as const,
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (cwd: string, args: readonly string[]) => spawnSync("git", [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd, env: environment, encoding: "utf8", timeout: 10_000 });
  const git = (cwd: string, ...args: string[]) => {
    const result = run(cwd, args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const remote = join(directory, "remote.git"), writer = join(directory, "writer"), checkout = join(directory, "checkout");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "init", "--initial-branch=main", writer);
  writeFileSync(join(writer, "tracked.txt"), "base\n");
  writeFileSync(join(writer, "package.json"), JSON.stringify({ name: "git-start-fixture", private: true, version: "1.0.0" }) + "\n");
  writeFileSync(join(writer, "package-lock.json"), JSON.stringify({ name: "git-start-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
  writeFileSync(join(writer, ".node-version"), process.version.slice(1) + "\n");
  writeFileSync(join(writer, ".gitignore"), "node_modules/\n");
  git(writer, "add", "tracked.txt", "package.json", "package-lock.json", ".node-version", ".gitignore");
  git(writer, "commit", "--no-gpg-sign", "-m", "base");
  git(writer, "remote", "add", "origin", remote);
  git(writer, "push", "--set-upstream", "origin", "main");
  git(directory, "clone", "--no-hardlinks", remote, checkout);
  const dependencies = syncDependencies(checkout, { install: target => mkdirSync(join(target, "node_modules"), { recursive: true }) });
  assert.equal(dependencies.state, "ready");
  const base = git(checkout, "rev-parse", "HEAD");
  const calls: string[][] = [];
  const runGit = (args: string[]) => { calls.push([...args]); return run(checkout, args); };
  const start = (mode: "new" | "continue", branch: string) => startTask({ directory: checkout, mode, branch, expectedRemote: remote, runGit });
  return { directory, remote, writer, checkout, base, git, run, calls, runGit, start };
}

function commit(f: Fixture, cwd: string, message: string, filename = "tracked.txt") {
  writeFileSync(join(cwd, filename), `${message}\n`);
  f.git(cwd, "add", filename);
  f.git(cwd, "commit", "--no-gpg-sign", "-m", message);
  return f.git(cwd, "rev-parse", "HEAD");
}

function worktreeFiles(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (current === directory && entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else result[relative(directory, path)] = readFileSync(path).toString("base64");
    }
  }
  visit(directory);
  return result;
}

function snapshot(f: Fixture) {
  return {
    sha: f.git(f.checkout, "rev-parse", "HEAD"),
    branch: f.git(f.checkout, "symbolic-ref", "--short", "HEAD"),
    index: readFileSync(join(f.checkout, ".git", "index")).toString("base64"),
    files: worktreeFiles(f.checkout),
    localBranches: f.git(f.checkout, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"),
  };
}

function assertNoBranch(f: Fixture, branch: string) {
  assert.equal(f.run(f.checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status, 1);
}

function assertFetched(f: Fixture) {
  const command = f.calls.find(args => args[0] === "fetch");
  assert.ok(command);
  assert.deepEqual([...command].sort(), [
    "fetch", "--prune", "--no-prune-tags", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/*:refs/remotes/origin/*",
  ].sort());
}

test("new starts from fetched main without moving local main or configuring tracking", t => {
  const f = fixture(t), latest = commit(f, f.writer, "remote main advanced");
  f.git(f.writer, "push", "origin", "main");
  const result = f.start("new", "codex/new-task");
  assert.deepEqual(result.before, { sha: f.base, branch: "main", dirty: false });
  assert.deepEqual(result.after, { sha: latest, branch: "codex/new-task", dirty: false });
  assert.equal(result.mainSha, latest);
  assert.deepEqual(result.mainComparison, { ahead: 0, behind: 0, sameTree: true });
  assert.equal(result.createdBranch, true);
  assert.equal(result.dependencies.state, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.unpublishedCommits, 0);
  assert.equal(result.ownRemoteComparison, null);
  assert.equal(f.git(f.checkout, "rev-parse", "refs/heads/main"), f.base);
  assert.equal(f.run(f.checkout, ["config", "--get", "branch.codex/new-task.remote"]).status, 1);
  assert.equal(f.run(f.checkout, ["config", "--get", "branch.codex/new-task.merge"]).status, 1);
  assertFetched(f);
});

test("unknown dependencies keep a successfully created branch but do not report readiness", t => {
  const f = fixture(t);
  rmSync(join(f.checkout, "node_modules", ".mille-dependencies.json"));
  const result = f.start("new", "codex/unknown-dependencies");
  assert.equal(result.createdBranch, true);
  assert.deepEqual(result.after, { sha: f.base, branch: "codex/unknown-dependencies", dirty: false });
  assert.deepEqual(result.mainComparison, { ahead: 0, behind: 0, sameTree: true });
  assert.equal(result.dependencies.state, "unknown");
  assert.equal(result.unpublishedCommits, 0);
  assert.equal(result.ready, false);
});

test("a fetched manifest change marks dependencies stale after preserving branch creation", t => {
  const f = fixture(t);
  const manifest = { name: "git-start-fixture", private: true, version: "2.0.0" };
  writeFileSync(join(f.writer, "package.json"), JSON.stringify(manifest) + "\n");
  f.git(f.writer, "add", "package.json");
  f.git(f.writer, "commit", "--no-gpg-sign", "-m", "change dependency input");
  f.git(f.writer, "push", "origin", "main");
  const latest = f.git(f.writer, "rev-parse", "HEAD");
  assert.equal(dependencyStatus(f.checkout).state, "ready");
  const result = f.start("new", "codex/stale-dependencies");
  assert.equal(result.createdBranch, true);
  assert.deepEqual(result.after, { sha: latest, branch: "codex/stale-dependencies", dirty: false });
  assert.deepEqual(result.mainComparison, { ahead: 0, behind: 0, sameTree: true });
  assert.equal(result.dependencies.state, "stale");
  assert.equal(result.ready, false);
  assert.equal(f.git(f.checkout, "rev-parse", "refs/heads/main"), f.base);
  assert.deepEqual(JSON.parse(readFileSync(join(f.checkout, "package.json"), "utf8")), manifest);
});

test("new can reuse a clean merged branch while preserving that branch", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/previous");
  const latest = commit(f, f.writer, "new upstream commit");
  f.git(f.writer, "push", "origin", "main");
  const result = f.start("new", "codex/next");
  assert.equal(result.after.sha, latest);
  assert.equal(result.after.branch, "codex/next");
  assert.equal(f.git(f.checkout, "rev-parse", "refs/heads/codex/previous"), f.base);
});

for (const kind of ["tracked", "staged", "untracked"] as const) {
  test(`new preserves ${kind} changes and refuses to create a branch`, t => {
    const f = fixture(t);
    writeFileSync(join(f.checkout, kind === "untracked" ? "new file.txt" : "tracked.txt"), "local changes\n");
    if (kind === "staged") f.git(f.checkout, "add", "tracked.txt");
    const before = snapshot(f);
    assert.throws(() => f.start("new", "codex/refused"));
    assert.deepEqual(snapshot(f), before);
    assertNoBranch(f, "codex/refused");
    assert.equal(f.calls.some(args => args[0] === "fetch"), false);
  });
}

for (const diverged of [false, true]) {
  test(`new refuses a ${diverged ? "diverged" : "locally ahead"} HEAD and retains all local commits`, t => {
    const f = fixture(t);
    f.git(f.checkout, "switch", "-c", "codex/existing");
    commit(f, f.checkout, "local unpublished", "local.txt");
    if (diverged) {
      commit(f, f.writer, "remote main diverged", "remote.txt");
      f.git(f.writer, "push", "origin", "main");
    }
    const before = snapshot(f);
    assert.throws(() => f.start("new", "codex/refused"));
    assert.deepEqual(snapshot(f), before);
    assertNoBranch(f, "codex/refused");
    assertFetched(f);
  });
}

test("continue preserves its branch and reports unpublished commits", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/current");
  const local = commit(f, f.checkout, "local feature");
  const before = snapshot(f), result = f.start("continue", "codex/current");
  assert.deepEqual(snapshot(f), before);
  assert.equal(result.createdBranch, false);
  assert.deepEqual(result.after, { sha: local, branch: "codex/current", dirty: false });
  assert.deepEqual(result.mainComparison, { ahead: 1, behind: 0, sameTree: false });
  assert.equal(result.unpublishedCommits, 1);
  assert.equal(result.ownRemoteComparison, null);
  assert.equal(result.dependencies.state, "ready");
  assert.equal(result.ready, false);
  assertFetched(f);
});

test("a published feature ahead of main is ready when its own remote and dependencies match", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/published");
  const feature = commit(f, f.checkout, "published feature");
  f.git(f.checkout, "push", "origin", "codex/published");
  const before = snapshot(f), result = f.start("continue", "codex/published");
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(result.after, { sha: feature, branch: "codex/published", dirty: false });
  assert.deepEqual(result.mainComparison, { ahead: 1, behind: 0, sameTree: false });
  assert.deepEqual(result.ownRemoteComparison, { ahead: 0, behind: 0 });
  assert.equal(result.unpublishedCommits, 0);
  assert.equal(result.dependencies.state, "ready");
  assert.equal(result.createdBranch, false);
  assert.equal(result.ready, true);
});

for (const kind of ["tracked", "staged", "untracked"] as const) {
  test(`continue reports ${kind} changes without editing HEAD, index or worktree`, t => {
    const f = fixture(t);
    f.git(f.checkout, "switch", "-c", "codex/current");
    writeFileSync(join(f.checkout, kind === "untracked" ? "new file.txt" : "tracked.txt"), "keep my changes\n");
    if (kind === "staged") f.git(f.checkout, "add", "tracked.txt");
    const before = snapshot(f), result = f.start("continue", "codex/current");
    assert.deepEqual(snapshot(f), before);
    assert.equal(result.before.dirty, true);
    assert.equal(result.after.dirty, true);
    assert.equal(result.dependencies.state, "ready");
    assert.equal(result.unpublishedCommits, 0);
    assert.deepEqual(result.mainComparison, { ahead: 0, behind: 0, sameTree: true });
    assert.equal(result.ownRemoteComparison, null);
    assert.equal(result.ready, false);
    assert.equal(result.createdBranch, false);
    assertFetched(f);
  });
}

test("continue reports a newly fetched main ahead of the current branch", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/current");
  const latest = commit(f, f.writer, "main ahead");
  f.git(f.writer, "push", "origin", "main");
  const before = snapshot(f), result = f.start("continue", "codex/current");
  assert.deepEqual(snapshot(f), before);
  assert.equal(result.mainSha, latest);
  assert.deepEqual(result.mainComparison, { ahead: 0, behind: 1, sameTree: false });
  assert.equal(result.unpublishedCommits, 0);
  assert.equal(result.dependencies.state, "ready");
  assert.equal(result.after.dirty, false);
  assert.equal(result.ownRemoteComparison, null);
  assert.equal(result.ready, false);
});

test("continue reports divergent main history without merging or dropping either side", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/current");
  commit(f, f.checkout, "local feature", "local.txt");
  commit(f, f.writer, "remote feature", "remote.txt");
  f.git(f.writer, "push", "origin", "main");
  const before = snapshot(f), result = f.start("continue", "codex/current");
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(result.mainComparison, { ahead: 1, behind: 1, sameTree: false });
  assert.equal(result.unpublishedCommits, 1);
  assert.equal(result.ready, false);
});

test("continue distinguishes identical trees from identical commit histories", t => {
  const f = fixture(t);
  f.git(f.checkout, "switch", "-c", "codex/current");
  f.git(f.checkout, "commit", "--allow-empty", "--no-gpg-sign", "-m", "same tree, new commit");
  const before = snapshot(f), result = f.start("continue", "codex/current");
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(result.mainComparison, { ahead: 1, behind: 0, sameTree: true });
  assert.equal(result.unpublishedCommits, 1);
  assert.equal(result.ready, false);
});

for (const divergence of ["ahead", "behind", "diverged"] as const) {
  test(`continue reports its own remote as ${divergence} without switching or resetting`, t => {
    const f = fixture(t);
    f.git(f.writer, "switch", "-c", "codex/current");
    f.git(f.writer, "push", "origin", "codex/current");
    f.git(f.checkout, "fetch", "origin");
    f.git(f.checkout, "switch", "--track", "origin/codex/current");
    if (divergence !== "ahead") {
      commit(f, f.writer, "remote topic commit", "remote.txt");
      f.git(f.writer, "push", "origin", "codex/current");
    }
    if (divergence !== "behind") {
      commit(f, f.checkout, "local topic commit", "local.txt");
      // Make the local commit published without advancing this branch's own remote.
      f.git(f.checkout, "push", "origin", "HEAD:refs/heads/codex/published-copy");
    }
    const before = snapshot(f), result = f.start("continue", "codex/current");
    assert.deepEqual(snapshot(f), before);
    assert.deepEqual(result.ownRemoteComparison, {
      ahead: divergence === "behind" ? 0 : 1, behind: divergence === "ahead" ? 0 : 1,
    });
    assert.equal(result.dependencies.state, "ready");
    assert.equal(result.unpublishedCommits, 0);
    assert.equal(result.after.dirty, false);
    assert.equal(result.mainComparison.behind, 0);
    assert.equal(result.ready, false);
  });
}

test("continue refuses a different expected branch without fetching or switching", t => {
  const f = fixture(t), before = snapshot(f);
  assert.throws(() => f.start("continue", "codex/other"));
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.calls.some(args => args[0] === "fetch"), false);
});

test("fetch failure never treats the previous origin/main as current", t => {
  const f = fixture(t), before = snapshot(f);
  renameSync(f.remote, join(f.directory, "unavailable.git"));
  assert.throws(() => f.start("new", "codex/refused"), /fetch/);
  assert.deepEqual(snapshot(f), before);
  assertNoBranch(f, "codex/refused");
  assertFetched(f);
});

test("fetch access denial is classified without exposing stderr credentials or changing local work", t => {
  const f = fixture(t), before = snapshot(f);
  const runGit = (args: string[]) => args[0] === "fetch" ? {
    status: 128, stdout: "", stderr: "403 Forbidden https://fixture-user:fixture-secret@github.com/tyask/mille.git",
  } : f.runGit(args);
  assert.throws(() => startTask({ directory: f.checkout, mode: "new", branch: "codex/refused", expectedRemote: f.remote, runGit }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /拒否/);
    assert.doesNotMatch(error.message, /fixture-user|fixture-secret|https:|github\.com/);
    return true;
  });
  assert.deepEqual(snapshot(f), before);
  assertNoBranch(f, "codex/refused");
});

for (const multiple of [false, true]) {
  test(`${multiple ? "multiple origin URLs" : "an unexpected origin"} is rejected before fetch`, t => {
    const f = fixture(t);
    const unexpected = join(f.directory, "another.git");
    if (multiple) f.git(f.checkout, "remote", "set-url", "--add", "origin", unexpected);
    else f.git(f.checkout, "remote", "set-url", "origin", unexpected);
    const before = snapshot(f);
    assert.throws(() => f.start("new", "codex/refused"), /origin/);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.calls.some(args => args[0] === "fetch"), false);
    assertNoBranch(f, "codex/refused");
  });
}

test("canonical HTTPS, SSH and SCP Mille origins identify the same repository", t => {
  for (const url of ["https://github.com/tyask/mille.git", "git@github.com:tyask/mille.git",
    "ssh://git@github.com/tyask/mille.git", "https://GITHUB.COM/TYASK/MILLE/"]) {
    const f = fixture(t);
    const runGit = (args: string[]) => args.join(" ") === "remote get-url --all origin"
      ? { status: 0, stdout: url + "\n" } : f.runGit(args);
    // Only URL discovery is mocked. Fetch still uses the isolated, file-only bare remote.
    const result = startTask({ directory: f.checkout, mode: "new", branch: "codex/canonical", runGit });
    assert.equal(result.createdBranch, true);
    assert.equal(result.after.sha, f.base);
    assertFetched(f);
  }
});

test("lookalike or credential-bearing origins are rejected before any fetch", t => {
  for (const url of ["https://github.com/tyask/other.git", "https://github.com.attacker.invalid/tyask/mille.git",
    "https://fixture-token@github.com/tyask/mille.git", "https://github.com/tyask/mille.git?query=fixture",
    "https://github.com/tyask/mille.git#fragment", "https://github.com:8443/tyask/mille.git"]) {
    const f = fixture(t), before = snapshot(f);
    const runGit = (args: string[]) => args.join(" ") === "remote get-url --all origin"
      ? { status: 0, stdout: url + "\n" } : f.runGit(args);
    assert.throws(() => startTask({ directory: f.checkout, mode: "new", branch: "codex/refused", runGit }), /origin/);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.calls.some(args => args[0] === "fetch"), false);
    assertNoBranch(f, "codex/refused");
  }
});

test("malformed URL forms are rejected before Git can reinterpret their transport", t => {
  for (const url of ["https:github.com/tyask/mille.git", "https:/github.com/tyask/mille.git",
    "https:///github.com/tyask/mille.git", "ssh:git@github.com/tyask/mille.git",
    "https://github.com/other/../tyask/mille.git", "https://github.com\\/tyask/mille.git",
    " https://github.com/tyask/mille.git", "https://github.com/tyask/mille.git\t"]) {
    const f = fixture(t), before = snapshot(f);
    f.git(f.checkout, "remote", "set-url", "origin", url);
    // Actual Git URL discovery, file-only transport: no network even if this guard regresses.
    assert.throws(() => startTask({ directory: f.checkout, mode: "new", branch: "codex/refused", runGit: f.runGit }), /origin/);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.calls.some(args => args[0] === "fetch"), false);
    assertNoBranch(f, "codex/refused");
  }
});

for (const remoteBranch of [false, true]) {
  test(`new rejects an existing ${remoteBranch ? "freshly fetched remote" : "local"} branch`, t => {
    const f = fixture(t);
    if (remoteBranch) {
      f.git(f.writer, "branch", "codex/duplicate");
      f.git(f.writer, "push", "origin", "codex/duplicate");
    } else f.git(f.checkout, "branch", "codex/duplicate");
    const before = snapshot(f);
    assert.throws(() => f.start("new", "codex/duplicate"));
    assert.deepEqual(snapshot(f), before);
    if (remoteBranch) assertNoBranch(f, "codex/duplicate");
    assertFetched(f);
  });
}

test("fetch prunes a removed remote branch before new checks for collisions", t => {
  const f = fixture(t);
  f.git(f.writer, "branch", "codex/removed");
  f.git(f.writer, "push", "origin", "codex/removed");
  f.git(f.checkout, "fetch", "origin");
  f.git(f.writer, "push", "origin", "--delete", "codex/removed");
  const result = f.start("new", "codex/removed");
  assert.equal(result.after.branch, "codex/removed");
  assert.equal(result.createdBranch, true);
  assert.equal(result.ownRemoteComparison, null);
});

test("fetch retains local-only tags even when tag pruning is enabled in local Git config", t => {
  const f = fixture(t);
  f.git(f.checkout, "tag", "local-only", f.base);
  f.git(f.checkout, "config", "fetch.pruneTags", "true");
  f.git(f.checkout, "config", "remote.origin.pruneTags", "true");
  const before = snapshot(f), result = f.start("continue", "main");
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.git(f.checkout, "rev-parse", "refs/tags/local-only"), f.base);
  assert.equal(result.ready, true);
  assertFetched(f);
});

test("new does not overwrite an ignored local file tracked by the latest main", t => {
  const f = fixture(t), excludes = join(f.directory, "fixture-excludes");
  writeFileSync(excludes, "ignored.txt\n");
  f.git(f.checkout, "config", "core.excludesFile", excludes);
  writeFileSync(join(f.checkout, "ignored.txt"), "personal ignored content\n");
  commit(f, f.writer, "upstream tracked content", "ignored.txt");
  f.git(f.writer, "push", "origin", "main");
  const before = snapshot(f);
  assert.equal(f.git(f.checkout, "status", "--porcelain=v1"), "");
  assert.throws(() => f.start("new", "codex/refused"));
  assert.deepEqual(snapshot(f), before);
  assertNoBranch(f, "codex/refused");
});

test("a removed origin/main is rejected after pruning rather than using its old SHA", t => {
  const f = fixture(t);
  f.git(f.writer, "branch", "other-main");
  f.git(f.writer, "push", "origin", "other-main");
  f.git(f.remote, "symbolic-ref", "HEAD", "refs/heads/other-main");
  f.git(f.writer, "push", "origin", "--delete", "main");
  const before = snapshot(f);
  assert.throws(() => f.start("new", "codex/refused"));
  assert.deepEqual(snapshot(f), before);
  assertNoBranch(f, "codex/refused");
  assert.equal(f.run(f.checkout, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"]).status, 1);
});

test("an unrelated main history is rejected without discarding the current history", t => {
  const f = fixture(t);
  f.git(f.writer, "switch", "--orphan", "unrelated");
  commit(f, f.writer, "unrelated root", "other.txt");
  f.git(f.writer, "push", "--force", "origin", "HEAD:main");
  const before = snapshot(f);
  assert.throws(() => f.start("new", "codex/refused"));
  assert.deepEqual(snapshot(f), before);
  assertNoBranch(f, "codex/refused");
});

for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG", "index.lock"]) {
  test(`an in-progress ${operation} blocks changes even with a clean worktree`, t => {
    const f = fixture(t), marker = join(f.checkout, ".git", operation);
    if (operation.startsWith("rebase-") || operation === "sequencer") mkdirSync(marker);
    else writeFileSync(marker, `${f.base}\n`);
    const before = snapshot(f);
    assert.throws(() => f.start("new", "codex/refused"));
    assert.deepEqual(snapshot(f), before);
    assert.equal(existsSync(marker), true);
    assert.equal(f.calls.some(args => args[0] === "fetch"), false);
    assertNoBranch(f, "codex/refused");
  });
}

for (const mutation of ["HEAD", "index", "untracked"] as const) {
  test(`a ${mutation} change during fetch stops branch creation and retains the concurrent change`, t => {
    const f = fixture(t);
    let concurrent: ReturnType<typeof snapshot> | undefined;
    const runGit = (args: string[]) => {
      const result = f.runGit(args);
      if (args[0] === "fetch" && result.status === 0) {
        if (mutation === "HEAD") {
          f.git(f.checkout, "commit", "--allow-empty", "--no-gpg-sign", "-m", "concurrent commit");
        } else {
          writeFileSync(join(f.checkout, mutation === "index" ? "tracked.txt" : "concurrent.txt"), "concurrent change\n");
          if (mutation === "index") f.git(f.checkout, "add", "tracked.txt");
        }
        concurrent = snapshot(f);
      }
      return result;
    };
    assert.throws(() => startTask({ directory: f.checkout, mode: "new", branch: "codex/refused", expectedRemote: f.remote, runGit }));
    assert.ok(concurrent);
    assert.deepEqual(snapshot(f), concurrent);
    assertNoBranch(f, "codex/refused");
  });
}
