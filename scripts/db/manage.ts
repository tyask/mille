import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createQuery, verifyDatabaseOwnership } from "../../lib/server/database/client";
import { hostedDatabaseConfiguration } from "../../lib/server/database/environment";
import { disableUserSql, migrationSql, registerUserSql, seedSql } from "./sql";

const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

export async function runDatabaseCommand(args: string[]): Promise<void> {
  const [command, ...flags] = args;
  const values = new Map<string, string>();
  let initialize = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--initialize") { if (initialize) throw new Error("引数が重複しています。"); initialize = true; continue; }
    if (!["--environment", "--expect-host", "--environment-id", "--email", "--name", "--user-id"].includes(flag)
      || values.has(flag) || !flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error("引数を確認してください。");
    values.set(flag, flags[++i]);
  }
  const target = values.get("--environment");
  if (target !== "preview" && target !== "production") throw new Error("--environment preview または production が必要です。");
  if (!["migrate", "register", "disable", "seed"].includes(command ?? "")) throw new Error("操作は migrate/register/disable/seed を指定してください。");
  if (initialize && command !== "migrate") throw new Error("--initialize は migrate 専用です。");
  const configuration = hostedDatabaseConfiguration(target, values.get("--expect-host") ?? "", values.get("--environment-id") ?? "");
  const query = createQuery(configuration);
  let statement: string;
  if (command === "migrate") statement = migrationSql(configuration, initialize);
  else {
    if (command === "seed") statement = seedSql(configuration);
    else if (command === "register") {
      const email = values.get("--email")?.trim().toLowerCase() ?? "";
      const name = values.get("--name")?.trim() ?? "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 1 || name.length > 120) throw new Error("登録メールと表示名を確認してください。");
      statement = registerUserSql(configuration, randomUUID(), email, name);
    } else {
      const id = values.get("--user-id") ?? "";
      if (!id || id.length > 200) throw new Error("停止対象の --user-id が必要です。");
      statement = disableUserSql(configuration, id);
    }
    await verifyDatabaseOwnership(query, configuration);
  }
  await query(statement);
  await verifyDatabaseOwnership(query, configuration);
  console.log(`Mille DB ${command}: ${target}/${configuration.environmentId} 完了`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvConfig(process.cwd());
  runDatabaseCommand(process.argv.slice(2)).catch(() => {
    console.error("DB操作に失敗しました。引数・接続先ホスト・専用DBの環境識別を確認してください。接続情報とDBエラー本文は表示しません。");
    process.exitCode = 1;
  });
}
