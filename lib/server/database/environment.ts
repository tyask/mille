type Environment = Readonly<Record<string, string | undefined>>;

export type DatabaseTarget = "preview" | "production";
export type DatabaseConfiguration = {
  mode: "memory";
  url: string;
  token: string;
  environment: "development";
  environmentId: "local-memory";
} | {
  mode: "hosted";
  url: string;
  host: string;
  environment: DatabaseTarget;
  environmentId: string;
};

const invalid = () => new Error("データベース設定が不足しているか、対象環境と一致しません。");

export function hostedDatabaseConfiguration(
  environment: DatabaseTarget,
  expectedHost: string,
  environmentId: string,
  variables: Environment = process.env,
): Extract<DatabaseConfiguration, { mode: "hosted" }> {
  const value = environment === "preview" ? variables.MILLE_PREVIEW_DATABASE_URL : variables.DATABASE_URL;
  if (!value || !expectedHost || !/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(expectedHost)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(environmentId)) throw invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalid(); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname !== expectedHost.toLowerCase()
    || !parsed.username || !parsed.password || parsed.pathname === "/"
    || parsed.searchParams.get("sslmode") === "disable") throw invalid();
  return { mode: "hosted", url: value, host: parsed.hostname, environment, environmentId };
}

export function databaseConfiguration(variables: Environment = process.env): DatabaseConfiguration {
  if (variables.MILLE_DB_MODE === "memory") {
    if (!["development", "test"].includes(variables.NODE_ENV ?? "") || variables.AUTH_MODE !== "test"
      || variables.VERCEL !== undefined || variables.VERCEL_ENV !== undefined
      || !/^[a-f0-9]{64}$/.test(variables.MILLE_MEMORY_DATABASE_TOKEN ?? "")) throw invalid();
    let parsed: URL;
    try { parsed = new URL(variables.MILLE_MEMORY_DATABASE_URL ?? ""); } catch { throw invalid(); }
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw invalid();
    return { mode: "memory", url: parsed.origin, token: variables.MILLE_MEMORY_DATABASE_TOKEN!,
      environment: "development", environmentId: "local-memory" };
  }
  if (variables.MILLE_DB_MODE !== undefined && variables.MILLE_DB_MODE !== "hosted") throw invalid();
  if (variables.MILLE_MEMORY_DATABASE_URL !== undefined || variables.MILLE_MEMORY_DATABASE_TOKEN !== undefined) throw invalid();
  if (variables.VERCEL_ENV === "preview") {
    return hostedDatabaseConfiguration("preview", variables.MILLE_PREVIEW_DATABASE_HOST ?? "",
      variables.MILLE_PREVIEW_ENVIRONMENT_ID ?? "", variables);
  }
  if (variables.VERCEL_ENV === "production") {
    return hostedDatabaseConfiguration("production", variables.MILLE_PRODUCTION_DATABASE_HOST ?? "",
      variables.MILLE_PRODUCTION_ENVIRONMENT_ID ?? "", variables);
  }
  throw invalid();
}

/** Configuration gate only. Database reads also verify the persisted environment marker. */
export function isTestEnvironmentConfigured(variables: Environment = process.env): boolean {
  if (variables.AUTH_MODE !== "test") return false;
  try {
    const configuration = databaseConfiguration(variables);
    return configuration.mode === "memory" || configuration.environment === "preview";
  } catch { return false; }
}
