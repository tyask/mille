import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const declarationExtension = /\.d\.[cm]?ts$/;
const assetExtension = /\.(?:css|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/;
const ignoredDirectories = new Set([".git", ".next", ".mille", "node_modules"]);
const sharedPackages = new Set(["zod"]);
const browserPackages = new Set([
  ...sharedPackages, "react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client",
  "next/image", "next/link", "next/navigation", "next/dynamic", "next/script", "next-auth/react",
  "qrcode.react",
]);

const within = (path, directory) => path === directory || path.startsWith(`${directory}/`);
const tooling = path => ["scripts", "tests", "docs"].some(directory => within(path, directory));
const pathInProject = (root, path) => relative(root, path).split(sep).join("/");
const serverOnly = path => within(path, "lib/server") || within(path, "app/api") || /^auth\.[cm]?[jt]s$/.test(path);

async function projectSources(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const local = pathInProject(root, path);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name) && !tooling(local)
      && local !== "out" && local !== "build") {
      files.push(...await projectSources(root, path));
    } else if (entry.isFile() && sourceExtension.test(entry.name) && !declarationExtension.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function inspectSource(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  let client = false;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") client = true;
  }

  function add(node, expression) {
    const literal = expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression));
    imports.push({ specifier: literal ? expression.text : null, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const bindings = node.exportClause;
      const onlyTypes = node.isTypeOnly || (bindings && ts.isNamedExports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { client, imports };
}

function moduleResolver(root) {
  const diagnostics = ts.createDiagnosticReporter(ts.sys);
  const configuration = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostics,
  });
  if (!configuration) throw new Error("tsconfig.json を読み取れません。");
  const options = configuration.options;
  const cache = ts.createModuleResolutionCache(root, path => path, options);
  return (path, specifier) => {
    const resolved = ts.resolveModuleName(specifier, path, options, ts.sys, cache).resolvedModule;
    const relativeImport = /^(?:\.{1,2}(?:\/|$)|\/)/.test(specifier);
    const aliasImport = specifier.startsWith("@/");
    if (!relativeImport && !aliasImport && (!resolved || resolved.isExternalLibraryImport)) return { package: specifier };
    const candidate = resolved?.resolvedFileName ?? (aliasImport ? resolve(root, specifier.slice(2)) : resolve(dirname(path), specifier));
    const target = pathInProject(root, candidate);
    if (target === ".." || target.startsWith("../") || isAbsolute(target)) return {};
    if (resolved || (assetExtension.test(extname(target)) && ts.sys.fileExists(candidate))) return { target };
    return {};
  };
}

/** Inspect the runtime import graph without loading application modules. */
export async function checkBoundaries(root) {
  const resolveImport = moduleResolver(root);
  const modules = new Map();
  for (const path of (await projectSources(root)).sort()) {
    const syntax = inspectSource(path, await readFile(path, "utf8"));
    modules.set(pathInProject(root, path), {
      client: syntax.client,
      imports: syntax.imports.map(dependency => ({
        ...dependency,
        ...(dependency.specifier === null ? {} : resolveImport(path, dependency.specifier)),
      })),
    });
  }
  const failures = [];
  const paths = [...modules.keys()];
  const client = path => within(path, "lib/client") || modules.get(path)?.client === true;
  for (const [path, syntax] of modules) {
    if (within(path, "lib") && !["client", "shared", "server"].some(layer => within(path, `lib/${layer}`))) {
      failures.push(`${path}: lib のモジュールは client、shared、server に配置してください。`);
    }
    for (const dependency of syntax.imports) {
      const location = `${path}:${dependency.line}`;
      if (dependency.specifier === null) {
        failures.push(`${location}: import()/require() の参照先を文字列リテラルで指定してください。`);
      } else if (dependency.target && tooling(dependency.target)) {
        failures.push(`${location}: アプリから開発用ファイルを読み込めません (${dependency.target})。`);
      } else if (!dependency.target && !dependency.package) {
        failures.push(`${location}: ローカル依存を解決できません (${dependency.specifier})。`);
      }
    }
  }

  function checkLayer(roots, forbidden, allowedPackages, label) {
    const queue = roots.map(path => [path]);
    const visited = new Set();
    for (let index = 0; index < queue.length; index++) {
      const chain = queue[index];
      const path = chain.at(-1);
      if (visited.has(path)) continue;
      visited.add(path);
      for (const dependency of modules.get(path)?.imports ?? []) {
        if (dependency.target) {
          if (forbidden(dependency.target)) {
            failures.push(`${path}:${dependency.line}: ${label}の依存境界に違反しています (${[...chain, dependency.target].join(" → ")})。`);
          } else if (modules.has(dependency.target)) {
            queue.push([...chain, dependency.target]);
          }
        } else if (dependency.package && allowedPackages && !allowedPackages.has(dependency.package)) {
          const description = isBuiltin(dependency.package) ? "Node.js 専用モジュール" : "許可されていない外部パッケージ";
          failures.push(`${path}:${dependency.line}: ${label}で${description}を読み込めません (${[...chain, dependency.package].join(" → ")})。`);
        }
      }
    }
  }

  checkLayer(paths.filter(client), serverOnly, browserPackages, "クライアント");
  checkLayer(paths.filter(path => within(path, "lib/shared")), path => !within(path, "lib/shared"), sharedPackages, "共有モジュール");
  checkLayer(paths.filter(path => within(path, "lib/server")), path => client(path) || within(path, "app") || within(path, "components"), undefined, "サーバー");
  return failures;
}

async function main(root) {
  const failures = await checkBoundaries(root);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("依存境界を確認しました。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(fileURLToPath(new URL("../", import.meta.url))).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
