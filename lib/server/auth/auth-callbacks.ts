import type { NextAuthConfig } from "next-auth";
import { z } from "zod";
import type { AppUser } from "../../shared/types";
import { containsTestIdentity, findTestUser, matchesTestIdentity } from "../../shared/test-users";
import { getAuthMode, type AuthEnvironment } from "./auth-mode";

export interface UserAccessStore {
  findUserByEmail(email: string): Promise<AppUser | null>;
  findUserByIdentity(id: string, email: string): Promise<AppUser | null>;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return z.email().safeParse(email).success ? email : null;
}

function isUsableUser(user: AppUser | null, environment: AuthEnvironment): user is AppUser {
  if (user?.isEnabled !== true || !user.id || !normalizeEmail(user.email)) return false;
  const mode = getAuthMode(environment);
  if (mode === "disabled") return false;
  if (mode === "test") return user.isTest === true && matchesTestIdentity(user);
  return user.isTest === false && !containsTestIdentity(user);
}

/** Session identities never grant access without a current, matching DB record. */
export async function resolveSessionUser(
  identity: { id?: string; email?: string | null } | undefined,
  findUser: UserAccessStore["findUserByIdentity"],
  environment: AuthEnvironment = process.env,
): Promise<AppUser | null> {
  const email = normalizeEmail(identity?.email);
  if (!identity?.id || !email || getAuthMode(environment) === "disabled") return null;
  try {
    const user = await findUser(identity.id, email);
    if (!isUsableUser(user, environment) || user.id !== identity.id || normalizeEmail(user.email) !== email) return null;
    return user;
  } catch {
    return null;
  }
}

export async function authorizeTestUser(
  key: unknown,
  store: UserAccessStore,
  environment: AuthEnvironment = process.env,
): Promise<AppUser | null> {
  if (getAuthMode(environment) !== "test") return null;
  const fixture = findTestUser(key);
  if (!fixture) return null;
  // Fixtures must already be seeded; authentication never creates or repairs users.
  return resolveSessionUser(fixture, store.findUserByIdentity.bind(store), environment);
}

/** Only HTTP(S) destinations on the configured application origin are accepted. */
export function safeRedirect(url: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url, base);
    if ((base.protocol === "https:" || base.protocol === "http:")
      && target.origin === base.origin && !target.username && !target.password) return target.href;
  } catch {
    // Invalid return destinations do not leave the application.
  }
  return baseUrl;
}

export function createAuthCallbacks(
  store: UserAccessStore,
  environment: () => AuthEnvironment = () => process.env,
): NonNullable<NextAuthConfig["callbacks"]> {
  async function googleUser(input: {
    user: { email?: string | null };
    profile?: { email?: string | null; email_verified?: unknown };
  }): Promise<AppUser | null> {
    if (getAuthMode(environment()) !== "google" || input.profile?.email_verified !== true) return null;
    const email = normalizeEmail(input.profile.email);
    if (!email || normalizeEmail(input.user.email) !== email) return null;
    try {
      const user = await store.findUserByEmail(email);
      return isUsableUser(user, environment()) && normalizeEmail(user.email) === email ? user : null;
    } catch {
      return null;
    }
  }

  return {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") return (await googleUser({ user, profile })) !== null;
      if (account?.provider !== "test-login" || getAuthMode(environment()) !== "test"
        || !matchesTestIdentity(user)) return false;
      return (await resolveSessionUser(user, store.findUserByIdentity.bind(store), environment())) !== null;
    },
    async jwt({ token, user, account, profile }) {
      let current: AppUser | null;
      if (account?.provider === "google") {
        if (!user) return null;
        current = await googleUser({ user, profile });
      } else if (account?.provider === "test-login") {
        if (getAuthMode(environment()) !== "test" || !user || !matchesTestIdentity(user)) return null;
        current = await resolveSessionUser(user, store.findUserByIdentity.bind(store), environment());
      } else if (account) {
        return null;
      } else {
        current = await resolveSessionUser({ id: token.sub, email: token.email }, store.findUserByIdentity.bind(store), environment());
      }
      if (!current) return null;
      // Google subject IDs and stale token profile fields never replace Mille's record.
      return { ...token, sub: current.id, email: current.email, name: current.name, picture: current.imageUrl };
    },
    async session({ session, token }) {
      const current = await resolveSessionUser({ id: token.sub, email: token.email }, store.findUserByIdentity.bind(store), environment());
      if (!current) {
        // Auth.js clears a JWT session when this callback fails, and returns null
        // from /api/auth/session instead of presenting a stale user as signed in.
        throw new Error("The Mille session is no longer available.");
      }
      session.user.id = current.id;
      session.user.email = current.email;
      session.user.name = current.name;
      session.user.image = current.imageUrl;
      return session;
    },
    redirect({ url, baseUrl }) {
      return safeRedirect(url, baseUrl);
    },
  };
}
