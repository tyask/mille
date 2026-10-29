import { isTestEnvironmentConfigured } from "../database/environment";

export type AuthMode = "google" | "test" | "disabled";
export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export function getAuthMode(environment: AuthEnvironment = process.env): AuthMode {
  // Hosted production cannot enable a Credentials provider through AUTH_MODE.
  if (environment.VERCEL_ENV === "production") return "google";
  if (environment.AUTH_MODE === undefined || environment.AUTH_MODE === "google") return "google";
  if (environment.AUTH_MODE !== "test") return "disabled";
  try {
    return isTestEnvironmentConfigured(environment) ? "test" : "disabled";
  } catch {
    return "disabled";
  }
}

export function isTestAuthEnabled(environment: AuthEnvironment = process.env): boolean {
  return getAuthMode(environment) === "test";
}
