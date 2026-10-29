import type { AppUser } from "../../shared/types";
import { verifiedDatabaseQuery, type DatabaseRow } from "./client";

function userFromRow(row: DatabaseRow): AppUser {
  return { id: String(row.id), email: String(row.email), name: String(row.name),
    imageUrl: row.image_url == null ? null : String(row.image_url),
    isEnabled: row.is_enabled === true, isTest: row.is_test === true };
}

function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

export async function findUserByEmail(email: string): Promise<AppUser | null> {
  const { query, configuration } = await verifiedDatabaseQuery();
  const rows = await query("SELECT id,email,name,image_url,is_enabled,is_test FROM app_users WHERE email = $1 LIMIT 1", [normalizeEmail(email)]);
  if (!rows[0]) return null;
  const user = userFromRow(rows[0]);
  if (configuration.environment === "production" && user.isTest) return null;
  return user;
}

export async function findUserByIdentity(id: string, email: string): Promise<AppUser | null> {
  const { query, configuration } = await verifiedDatabaseQuery();
  const rows = await query("SELECT id,email,name,image_url,is_enabled,is_test FROM app_users WHERE id = $1 AND email = $2 AND is_enabled = true LIMIT 1", [id, normalizeEmail(email)]);
  if (!rows[0]) return null;
  const user = userFromRow(rows[0]);
  if (configuration.environment === "production" && user.isTest) return null;
  return user;
}
