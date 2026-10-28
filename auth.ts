import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { getAuthMode } from "./lib/server/auth/auth-mode";
import { authorizeTestUser, createAuthCallbacks } from "./lib/server/auth/auth-callbacks";
import { findUserByEmail, findUserByIdentity } from "./lib/server/database/users";

const store = { findUserByEmail, findUserByIdentity };
const mode = getAuthMode();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: mode === "test" ? [Credentials({
    id: "test-login",
    name: "テストユーザー",
    credentials: { testUserKey: { label: "テストユーザー", type: "text" } },
    async authorize(credentials) {
      const user = await authorizeTestUser(credentials?.testUserKey, store);
      return user ? { id: user.id, email: user.email, name: user.name, image: user.imageUrl } : null;
    },
  })] : mode === "google" ? [Google] : [],
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/", error: "/" },
  callbacks: createAuthCallbacks(store),
});
