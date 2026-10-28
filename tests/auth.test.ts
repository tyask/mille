import assert from "node:assert/strict";
import test from "node:test";
import type { NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { getAuthMode, isTestAuthEnabled, type AuthEnvironment } from "../lib/server/auth/auth-mode";
import { authorizeTestUser, createAuthCallbacks, normalizeEmail, resolveSessionUser, safeRedirect, type UserAccessStore } from "../lib/server/auth/auth-callbacks";
import type { AppUser } from "../lib/shared/types";
import { TEST_USERS } from "../lib/shared/test-users";

type Callbacks = NonNullable<NextAuthConfig["callbacks"]>;
type SignInInput = Parameters<NonNullable<Callbacks["signIn"]>>[0];
type JwtInput = Parameters<NonNullable<Callbacks["jwt"]>>[0];
type SessionInput = Parameters<NonNullable<Callbacks["session"]>>[0];

const registered: AppUser = {
  id: "mille-internal-id", email: "person@example.test", name: "保存した表示名", imageUrl: null,
  isEnabled: true, isTest: false,
};
const googleEnvironment: AuthEnvironment = { AUTH_MODE: "google", VERCEL_ENV: "production" };
const memoryEnvironment: AuthEnvironment = {
  AUTH_MODE: "test", NODE_ENV: "development", MILLE_DB_MODE: "memory",
  MILLE_MEMORY_DATABASE_URL: "http://127.0.0.1:32123", MILLE_MEMORY_DATABASE_TOKEN: "a".repeat(64),
};
const previewEnvironment: AuthEnvironment = {
  AUTH_MODE: "test", VERCEL_ENV: "preview", VERCEL: "1",
  MILLE_PREVIEW_DATABASE_URL: "postgresql://fixture:fixture@ep-mille-preview.example.test/mille?sslmode=require",
  MILLE_PREVIEW_DATABASE_HOST: "ep-mille-preview.example.test", MILLE_PREVIEW_ENVIRONMENT_ID: "mille-preview-test",
};

function fixture(initial: AppUser | null = registered, environment: AuthEnvironment = googleEnvironment) {
  const state = { user: initial ? { ...initial } : null, reads: 0, fail: false };
  const store: UserAccessStore = {
    async findUserByEmail(email) {
      state.reads++;
      if (state.fail) throw new Error("Database unavailable");
      return state.user?.email === email ? state.user : null;
    },
    async findUserByIdentity(id, email) {
      state.reads++;
      if (state.fail) throw new Error("Database unavailable");
      return state.user?.id === id && state.user.email === email ? state.user : null;
    },
  };
  return { state, store, callbacks: createAuthCallbacks(store, () => environment) };
}

function googleInput(profile: unknown = { email: registered.email, email_verified: true }): SignInInput {
  return {
    user: { id: "google-provider-subject", email: registered.email, name: "Googleの名前" },
    account: { provider: "google", type: "oidc", providerAccountId: "google-provider-subject" }, profile: profile as SignInInput["profile"],
  };
}

function ongoingJwt(token: JWT): JwtInput {
  return { token, account: null } as JwtInput;
}

function sessionInput(token: JWT): SessionInput {
  return { token, session: { user: { id: "stale-id", email: "stale@example.test", name: "古い表示名" }, expires: "2099-01-01T00:00:00.000Z" } } as SessionInput;
}

test("Google認証は確認済みメールと登録済み有効アカウントのみ許可する", async () => {
  const { callbacks } = fixture();
  assert.equal(await callbacks.signIn!(googleInput()), true);
  for (const user of [null, { ...registered, isEnabled: false }]) {
    assert.equal(await fixture(user).callbacks.signIn!(googleInput()), false);
  }
});

test("未確認メール・確認フラグ欠落・別メールはDBを照合する前に拒否する", async () => {
  for (const profile of [
    { email: registered.email, email_verified: false },
    { email: registered.email, email_verified: "true" },
    { email: registered.email },
    { email: "someone@example.test", email_verified: true },
    { email: "invalid", email_verified: true },
  ]) {
    const { callbacks, state } = fixture();
    assert.equal(await callbacks.signIn!(googleInput(profile)), false);
    assert.equal(state.reads, 0);
  }
});

test("メールは前後空白と大小文字だけ正規化し、別名を同一視しない", () => {
  assert.equal(normalizeEmail(" PERSON@Example.Test "), registered.email);
  assert.equal(normalizeEmail("person+other@example.test"), "person+other@example.test");
  assert.equal(normalizeEmail("invalid"), null);
  assert.equal(normalizeEmail(undefined), null);
});

test("Google JWTは内部IDと保存済みプロフィールを使い、providerのIDや名前を採用しない", async () => {
  const { callbacks } = fixture();
  const input = { ...googleInput(), token: { sub: "google-provider-subject" }, trigger: "signIn" } as JwtInput;
  const token = await callbacks.jwt!(input);
  assert.equal(token?.sub, registered.id);
  assert.equal(token?.email, registered.email);
  assert.equal(token?.name, registered.name);
});

test("ログイン途中に利用停止されたGoogleアカウントへJWTを発行しない", async () => {
  const { callbacks, state } = fixture();
  assert.equal(await callbacks.signIn!(googleInput()), true);
  state.user!.isEnabled = false;
  const input = { ...googleInput(), token: {}, trigger: "signIn" } as JwtInput;
  assert.equal(await callbacks.jwt!(input), null);
});

test("既存JWTでも利用停止・削除・IDやメール不一致ならセッションを失効させる", async () => {
  const token = { sub: registered.id, email: registered.email };
  for (const user of [null, { ...registered, isEnabled: false }, { ...registered, id: "someone-else" }, { ...registered, email: "someone@example.test" }]) {
    const { callbacks } = fixture(user);
    assert.equal(await callbacks.jwt!(ongoingJwt(token)), null);
  }
});

test("通常セッションはDBの最新プロフィールだけを返す", async () => {
  const current = { ...registered, name: "最新の表示名", imageUrl: "https://images.example.test/avatar" };
  const { callbacks } = fixture(current);
  const result = await callbacks.session!(sessionInput({ sub: registered.id, email: registered.email, name: "JWTの古い表示名" }));
  assert.deepEqual(result.user, { id: current.id, email: current.email, name: current.name, image: current.imageUrl });
  assert.equal("isEnabled" in result.user, false);
  assert.equal("isTest" in result.user, false);
});

test("JWT検証後でも利用停止された場合はsession callbackがユーザーを返さない", async () => {
  const { callbacks, state } = fixture();
  const token = await callbacks.jwt!(ongoingJwt({ sub: registered.id, email: registered.email }));
  assert.ok(token);
  state.user!.isEnabled = false;
  await assert.rejects(async () => callbacks.session!(sessionInput(token)), /session is no longer available/);
});

test("DB障害ではログイン・JWT・現在ユーザーをfail closedにする", async () => {
  const { callbacks, state, store } = fixture();
  state.fail = true;
  assert.equal(await callbacks.signIn!(googleInput()), false);
  assert.equal(await callbacks.jwt!(ongoingJwt({ sub: registered.id, email: registered.email })), null);
  assert.equal(await resolveSessionUser(registered, store.findUserByIdentity, googleEnvironment), null);
  await assert.rejects(async () => callbacks.session!(sessionInput({ sub: registered.id, email: registered.email })), /session is no longer available/);
});

test("未知providerのログインとJWT発行を拒否する", async () => {
  const { callbacks } = fixture();
  const input = googleInput();
  input.account!.provider = "unknown";
  assert.equal(await callbacks.signIn!(input), false);
  assert.equal(await callbacks.jwt!({ ...input, token: {} } as JwtInput), null);
});

test("本番ではAUTH_MODE=testを指定してもGoogleだけを選択する", () => {
  assert.equal(getAuthMode({ ...memoryEnvironment, VERCEL_ENV: "production" }), "google");
  assert.equal(isTestAuthEnabled({ ...previewEnvironment, VERCEL_ENV: "production" }), false);
});

test("テスト認証は明示的なmemoryまたは専用Preview構成だけで有効になる", () => {
  assert.equal(getAuthMode(memoryEnvironment), "test");
  assert.equal(getAuthMode(previewEnvironment), "test");
  for (const environment of [
    { AUTH_MODE: "test" },
    { ...memoryEnvironment, VERCEL: "1" },
    { ...memoryEnvironment, NODE_ENV: "production" },
    { ...memoryEnvironment, MILLE_MEMORY_DATABASE_TOKEN: undefined },
    { ...previewEnvironment, MILLE_PREVIEW_DATABASE_URL: undefined, DATABASE_URL: previewEnvironment.MILLE_PREVIEW_DATABASE_URL },
    { ...previewEnvironment, MILLE_PREVIEW_DATABASE_HOST: "other.example.test" },
    { ...previewEnvironment, MILLE_PREVIEW_ENVIRONMENT_ID: undefined },
    { AUTH_MODE: "unexpected" },
  ]) assert.equal(getAuthMode(environment), "disabled");
});

test("不正なテスト構成でGoogleへフォールバックせず全ログインを拒否する", async () => {
  const environment = { AUTH_MODE: "test" };
  const { callbacks, state, store } = fixture(registered, environment);
  assert.equal(await callbacks.signIn!(googleInput()), false);
  assert.equal(await resolveSessionUser(registered, store.findUserByIdentity, environment), null);
  assert.equal(state.reads, 0);
});

test("シード済みの固定A/Bだけを認証し、初回ログインによる登録や再有効化をしない", async () => {
  for (const user of TEST_USERS) {
    const { store, callbacks } = fixture(user, memoryEnvironment);
    assert.deepEqual(await authorizeTestUser(user.key, store, memoryEnvironment), user);
    const input = { user: { ...user, image: null }, account: { provider: "test-login", type: "credentials", providerAccountId: user.id } } as SignInInput;
    assert.equal(await callbacks.signIn!(input), true);
    const token = await callbacks.jwt!({ ...input, token: {} } as JwtInput);
    assert.equal(token?.sub, user.id);
    for (const record of [null, { ...user, isEnabled: false }, { ...user, isTest: false }]) {
      assert.equal(await authorizeTestUser(user.key, fixture(record, memoryEnvironment).store, memoryEnvironment), null);
    }
  }
});

test("未知のテストキーやID・メールの組み換えで別ユーザーを認証できない", async () => {
  const user = TEST_USERS[0];
  const { store, callbacks } = fixture(user, memoryEnvironment);
  assert.equal(await authorizeTestUser("unknown", store, memoryEnvironment), null);
  for (const identity of [{ ...user, email: TEST_USERS[1].email }, { ...user, id: TEST_USERS[1].id }]) {
    const input = { user: identity, account: { provider: "test-login", type: "credentials", providerAccountId: identity.id } } as SignInInput;
    assert.equal(await callbacks.signIn!(input), false);
    assert.equal(await callbacks.jwt!({ ...input, token: {} } as JwtInput), null);
  }
});

test("Googleと本番ではfixtureやisTestアカウントを通常ユーザーに昇格できない", async () => {
  for (const user of [
    TEST_USERS[0],
    { ...TEST_USERS[0], isTest: false },
    { ...registered, isTest: true },
    { ...registered, id: TEST_USERS[0].id },
    { ...registered, email: TEST_USERS[0].email },
  ]) {
    const { callbacks, store } = fixture(user, { ...googleEnvironment, AUTH_MODE: "test" });
    const input = googleInput({ email: user.email, email_verified: true });
    input.user.email = user.email;
    assert.equal(await callbacks.signIn!(input), false);
    assert.equal(await resolveSessionUser(user, store.findUserByIdentity, googleEnvironment), null);
    assert.equal(await authorizeTestUser(TEST_USERS[0].key, store, googleEnvironment), null);
  }
});

test("有効なテスト環境でもGoogleアカウントを混在させない", async () => {
  const { callbacks } = fixture(registered, memoryEnvironment);
  assert.equal(await callbacks.signIn!(googleInput()), false);
  assert.equal(await callbacks.jwt!(ongoingJwt({ sub: registered.id, email: registered.email })), null);
});

test("ログイン後の遷移は同一originのHTTP(S)だけを許可する", () => {
  const base = "https://mille.example.test";
  assert.equal(safeRedirect("/", base), base + "/");
  assert.equal(safeRedirect("/account?tab=profile", base), base + "/account?tab=profile");
  assert.equal(safeRedirect(base + "/", base), base + "/");
  for (const destination of [
    "https://other.example.test/", "//other.example.test/", "javascript:alert(1)",
    "https://mille.example.test.evil.test/", "https://mille.example.test@evil.test/",
    "https://user:password@mille.example.test/", "http://mille.example.test/", "https://mille.example.test:444/",
  ]) assert.equal(safeRedirect(destination, base), base);
});
