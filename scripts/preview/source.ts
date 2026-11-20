import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewTarget } from "./target";

const origin = "https://github.com/tyask/mille.git";
const maxSourceBytes = 12 * 1024 * 1024;
const shaPattern = /^[a-f0-9]{40}$/;
const gitEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  NODE_ENV: "production",
  GIT_ALLOW_PROTOCOL: "https",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  // Retain runner proxy and trust settings.
  http_proxy: process.env.http_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  https_proxy: process.env.https_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  no_proxy: process.env.no_proxy,
  NO_PROXY: process.env.NO_PROXY,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE,
  SSL_CERT_DIR: process.env.SSL_CERT_DIR,
  GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO,
};

function git(directory: string, args: string[], input?: string, token?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const authentication = token ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    } : {};
    const child = execFile("git", ["-c", "http.followRedirects=false", ...args], {
      cwd: directory, env: { ...gitEnvironment, ...authentication },
      encoding: "buffer", timeout: 90_000, maxBuffer: maxSourceBytes + 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error("GitHub の PR ソースを取得できません。"));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Read Git blobs directly so PR files cannot trigger checkout filters, hooks, or scripts. */
export async function readPreviewTree(directory: string, sha: string) {
  if (!shaPattern.test(sha)) throw new Error("ソース SHA が無効です。");
  const tree = await git(directory, ["ls-tree", "-rlz", "--full-tree", sha]);
  const entries = new TextDecoder("utf-8", { fatal: true }).decode(tree).split("\0");
  if (entries.pop() !== "" || entries.length > 1_000) throw new Error("PR のソース一覧が無効です。");

  let bytes = 0;
  const files = entries.flatMap((entry) => {
    const item = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([^\r\n\t]+)$/.exec(entry);
    if (!item) throw new Error("PR のソースに通常ファイル以外が含まれています。");
    const [, , object, size, file] = item;
    const segments = file.split("/");
    if (file.includes("\\") || segments.some((part) =>
      !part || part === "." || part === ".." || /^\.(git|vercel)$/i.test(part))) {
      throw new Error("PR のソースに使用できないパスが含まれています。");
    }
    if (file === ".env.example") return [];
    if (segments.some((part) => /^\.env(?:\.|$)/i.test(part))) throw new Error("PR のソースに環境ファイルが含まれています。");
    bytes += Number(size);
    if (bytes > maxSourceBytes) throw new Error("PR のソースがサイズ上限を超えています。");
    return [{ file, object, size: Number(size) }];
  });
  const packed = await git(directory, ["cat-file", "--batch"], files.map(({ object }) => `${object}\n`).join(""));
  let offset = 0;
  const source = files.map(({ file, object, size }) => {
    const headerEnd = packed.indexOf(10, offset);
    if (headerEnd === -1 || packed.toString("ascii", offset, headerEnd) !== `${object} blob ${size}`) {
      throw new Error("PR のソースの Git オブジェクトが一致しません。");
    }
    const end = headerEnd + 1 + size;
    if (packed[end] !== 10) throw new Error("PR のソースの Git オブジェクトが欠けています。");
    offset = end + 1;
    return { file, data: packed.subarray(headerEnd + 1, end) };
  });
  if (offset !== packed.length) throw new Error("PR のソースに余分な Git オブジェクトがあります。");
  return source;
}

export async function loadPreviewSource(target: PreviewTarget, token: string) {
  if (!token || target.operation !== "deploy" || !Number.isSafeInteger(target.number) || target.number < 1
    || !shaPattern.test(target.sha)) throw new Error("PR ソースの取得対象が無効です。");

  const directory = await mkdtemp(join(tmpdir(), "mille-preview-"));
  try {
    await git(directory, ["init", "--bare", "--template="]);
    await git(directory, ["fetch", "--no-tags", "--depth=1", "--no-recurse-submodules", origin,
      `refs/pull/${target.number}/head`], undefined, token);
    const fetched = (await git(directory, ["rev-parse", "FETCH_HEAD"])).toString("ascii").trim();
    if (fetched !== target.sha) throw new Error("取得した PR ソースの SHA が現在の HEAD と一致しません。");
    return await readPreviewTree(directory, fetched);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
