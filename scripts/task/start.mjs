import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyStatus } from "../cloud/dependencies.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repository = "https://github.com/tyask/mille.git";

function identity(value) {
  // Never include the configured URL in errors: it could contain credentials.
  if (/[\s\\]/.test(value)) return null;
  // Git treats schemes and SSH usernames as case-sensitive; only the host/repository may casefold.
  if (!["https://", "ssh://git@", "git@"].some(prefix => value.startsWith(prefix))) return null;
  // Git also accepts SCP syntax. Do not let WHATWG URL correction reinterpret it as HTTPS.
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9_-]+)\/([a-z0-9._-]+?)(?:\.git)?\/?$/i.exec(value);
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
}

function gitAt(root, runGit) {
  return (args, allowed = [0]) => {
    let result;
    try {
      result = runGit ? runGit(args) : spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch { throw new Error(`Git ${args[0]} を実行できませんでした。最新性は確認できていません。`); }
    if (result.error || !allowed.includes(result.status)) {
      const reason = result.error?.code === "ETIMEDOUT" ? "タイムアウト"
        : /403|forbidden|permission denied|authentication failed|could not read username/i.test(String(result.stderr ?? "")) ? "アクセス・認証拒否"
        : `終了状態 ${result.status ?? "不明"}`;
      throw new Error(`Git ${args[0]} が失敗しました（${reason}）。既存の作業を保持して停止します。最新性は確認できていません。`);
    }
    const rawOutput = String(result.stdout ?? "");
    return { code: result.status, output: rawOutput.trim(), rawOutput };
  };
}

function snapshot(git) {
  const sha = git(["rev-parse", "--verify", "HEAD^{commit}"]).output;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("完全な HEAD SHA を取得できません。");
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]).output || null;
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).output;
  return { sha, branch, dirty: status.length > 0, status };
}

function comparison(git, left, right) {
  const numbers = git(["rev-list", "--left-right", "--count", `${left}...${right}`]).output.split(/\s+/).map(Number);
  if (numbers.length !== 2 || numbers.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Git の比較結果を確認できません。");
  }
  return { ahead: numbers[0], behind: numbers[1] };
}

function publicSnapshot(value) {
  return { sha: value.sha, branch: value.branch, dirty: value.dirty };
}

/**
 * The CLI always pins Mille; isolated local Git fixtures may replace the remote and transport.
 * @param {{directory?: string, mode?: "new" | "continue", branch?: string, expectedRemote?: string,
 * runGit?: (args: string[]) => {status: number | null, stdout: string, stderr?: string, error?: Error}}} [options]
 */
export function startTask({ directory: root = directory, mode, branch, expectedRemote = repository, runGit } = {}) {
  if (!["new", "continue"].includes(mode) || typeof branch !== "string" || branch.startsWith("-")) {
    throw new Error("使い方: npm run task:start -- new codex/<name> | continue <既存ブランチ>");
  }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"]) {
    if (process.env[name] !== undefined) throw new Error("Git 作業先を上書きする環境変数があります。対象を確認してください。");
  }
  const git = gitAt(root, runGit);
  if (git(["check-ref-format", "--branch", branch], [0, 1, 128]).code !== 0 || branch === "HEAD"
    || (mode === "new" && !/^codex\/[a-z0-9][a-z0-9/._-]*$/i.test(branch))) {
    throw new Error("ブランチ名が不正です。新規作業では codex/<name> を指定してください。");
  }
  if (realpathSync(git(["rev-parse", "--show-toplevel"]).output) !== realpathSync(root)) {
    throw new Error("checkout の root で実行してください。");
  }
  const urls = git(["remote", "get-url", "--all", "origin"]).rawOutput.replace(/\r?\n$/, "").split(/\r?\n/);
  const expectedIdentity = identity(expectedRemote);
  if (urls.length !== 1 || (expectedIdentity ? identity(urls[0]) !== expectedIdentity : urls[0] !== expectedRemote)) {
    throw new Error("origin が対象の Mille リポジトリと一致しません。通信せず停止します。");
  }
  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG", "index.lock"]) {
    const path = git(["rev-parse", "--git-path", operation]).output;
    if (existsSync(resolve(root, path))) throw new Error("進行中の Git 操作があります。自動変更せず停止します。");
  }
  const before = snapshot(git);
  if (mode === "new" && before.dirty) throw new Error("未コミット変更があります。新規ブランチへ切り替えず保持します。");
  if (mode === "continue" && before.branch !== branch) throw new Error("継続対象のブランチと現在のブランチが一致しません。切り替えず停止します。");

  git(["fetch", "--prune", "--no-tags", "--no-prune-tags", "--no-recurse-submodules", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const fetched = snapshot(git);
  if (before.sha !== fetched.sha || before.branch !== fetched.branch || before.status !== fetched.status) {
    throw new Error("fetch 中に作業状態が変わりました。切り替えず停止します。");
  }
  const mainSha = git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]).output;
  if (!/^[a-f0-9]{40}$/.test(mainSha)) throw new Error("最新 origin/main の SHA を確認できません。");
  // A missing merge base (e.g. insufficient shallow history) is not proof of ancestry.
  git(["merge-base", "HEAD", mainSha]);
  if (mode === "new") {
    if (git(["merge-base", "--is-ancestor", before.sha, mainSha], [0, 1]).code !== 0) {
      throw new Error("現在の HEAD に main 未反映のコミットまたは分岐があります。元のブランチを保持して停止します。");
    }
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      if (git(["show-ref", "--verify", "--quiet", ref], [0, 1]).code === 0) {
        throw new Error("同名ブランチが既に存在します。新規作成を繰り返さず継続作業か確認してください。");
      }
    }
    // Pin the fetched SHA, rather than a ref that another fetch could move.
    git(["switch", "--no-overwrite-ignore", "--no-track", "-c", branch, mainSha]);
  }
  const after = snapshot(git);
  if (mode === "continue" && (before.sha !== after.sha || before.branch !== after.branch || before.status !== after.status)) {
    throw new Error("確認中に作業状態が変わりました。再確認が必要です。");
  }
  if (mode === "new" && (after.sha !== mainSha || after.branch !== branch || after.dirty)) {
    throw new Error("ブランチ作成後の状態が変わりました。現状を保持して確認してください。");
  }
  const mainComparison = comparison(git, after.sha, mainSha);
  const sameTree = git(["rev-parse", `${after.sha}^{tree}`]).output === git(["rev-parse", `${mainSha}^{tree}`]).output;
  const ownRef = `refs/remotes/origin/${branch}`;
  const ownRemoteComparison = git(["show-ref", "--verify", "--quiet", ownRef], [0, 1]).code === 0
    ? comparison(git, after.sha, ownRef) : null;
  const unpublishedCommits = Number(git(["rev-list", "--count", after.sha, "--not", "--remotes=origin"]).output);
  if (!Number.isSafeInteger(unpublishedCommits) || unpublishedCommits < 0) throw new Error("未公開コミット数を確認できません。");
  const dependencies = dependencyStatus(root);
  const ready = !after.dirty && unpublishedCommits === 0 && mainComparison.behind === 0
    && (!ownRemoteComparison || (ownRemoteComparison.ahead === 0 && ownRemoteComparison.behind === 0))
    && dependencies.state === "ready";
  return {
    mode, before: publicSnapshot(before), after: publicSnapshot(after), mainSha,
    mainComparison: { ...mainComparison, sameTree }, ownRemoteComparison, unpublishedCommits,
    dependencies, ready, createdBranch: mode === "new",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("使い方: npm run task:start -- new codex/<name> | continue <既存ブランチ>");
    const result = startTask({ mode: process.argv[2], branch: process.argv[3] });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) {
      console.error("要対応です。差分・未公開コミットは保持してください。依存が unknown/stale の場合は npm run deps:sync 後、continue で再確認してください。");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "作業開始確認に失敗しました。");
    process.exitCode = 1;
  }
}
