import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Query } from "../../lib/server/database/client";
import { databaseConfiguration, type DatabaseConfiguration } from "../../lib/server/database/environment";
import { migrateDatabase } from "../db/migrate";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;
type HostedConfiguration = Extract<DatabaseConfiguration, { mode: "hosted" }>;
type BuildSteps = {
  build(): void | Promise<void>;
  migrate(configuration: HostedConfiguration): void | Promise<void>;
};

function hostedBuild(environment: BuildEnvironment): boolean {
  return Boolean(environment.VERCEL_BUILD_IMAGE?.trim());
}

function deploymentIdentified(environment: BuildEnvironment): boolean {
  return /^dpl_[a-z0-9]+$/i.test(environment.VERCEL_DEPLOYMENT_ID ?? "");
}

function productionConfiguration(environment: BuildEnvironment): HostedConfiguration | null {
  const target = environment.VERCEL_ENV;
  const declaredTarget = environment.VERCEL_TARGET_ENV;
  if (target !== "production" && declaredTarget !== "production") {
    if (hostedBuild(environment) && (environment.VERCEL !== "1" || (target !== "preview" && target !== "development"))) {
      throw new Error("Vercelのビルド環境を確認できません。");
    }
    return null;
  }
  // The local Vercel CLI also sets VERCEL=1 and can load deployment metadata.
  if (!hostedBuild(environment) || environment.VERCEL !== "1" || !deploymentIdentified(environment)
    || target !== "production" || environment.VERCEL_GIT_COMMIT_REF !== "main"
    || (declaredTarget !== undefined && declaredTarget !== "production")) {
    throw new Error("本番ビルドの環境とmainブランチを確認できません。");
  }

  const configuration = databaseConfiguration(environment);
  if (configuration.mode !== "hosted" || configuration.environment !== "production" || configuration.environmentId !== "mille-production"
    || !/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(configuration.host)) {
    throw new Error("Mille本番DBの接続設定を確認できません。");
  }

  // Validate the configured runtime URL first. Neon assigns the -pooler hostname
  // to the same endpoint; schema changes use its direct hostname.
  const direct = new URL(configuration.url);
  if (direct.searchParams.getAll("sslmode").includes("disable")) {
    throw new Error("Mille本番DBのTLS設定を確認できません。");
  }
  direct.hostname = configuration.host.replace(/^(ep-[a-z0-9-]+)-pooler\./, "$1.");
  return { ...configuration, host: direct.hostname, url: direct.href };
}

export function migrateVercelDatabase(configuration: HostedConfiguration, query?: Query): Promise<void> {
  return migrateDatabase(configuration, { query });
}

export async function runVercelBuild(environment: BuildEnvironment, steps: BuildSteps): Promise<void> {
  const configuration = productionConfiguration(environment);
  try {
    await steps.build();
  } catch {
    throw new Error("Next.jsのビルドに失敗しました。");
  }
  if (configuration) {
    try {
      await steps.migrate(configuration);
    } catch {
      throw new Error("Mille本番DBの照合またはマイグレーションに失敗しました。");
    }
  }
}

const buildSteps: BuildSteps = {
  build() {
    if (hostedBuild(process.env) && process.env.VERCEL === "1" && deploymentIdentified(process.env)) {
      console.log("Mille: Vercelのホストビルドとデプロイ識別を確認しました。");
    }
    console.log("Mille: Next.jsのビルドを開始します。");
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    const build = spawnSync(process.execPath, [next, "build"], { stdio: "inherit" });
    if (build.error || build.status !== 0) throw new Error("Next.jsのビルドに失敗しました。");
  },
  async migrate(configuration) {
    console.log("Mille: 本番DBの照合と未適用マイグレーションを開始します。");
    await migrateVercelDatabase(configuration);
    console.log("Mille: 本番DBの照合とマイグレーションが完了しました。");
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVercelBuild(process.env, buildSteps).catch(error => {
    console.error(error instanceof Error ? error.message : "Vercelビルドに失敗しました。");
    process.exitCode = 1;
  });
}
