export const TEST_USERS = [
  {
    key: "user-a",
    id: "mille-test-user-a",
    email: "test-a@mille.invalid",
    name: "テストユーザーA",
    imageUrl: null,
    isEnabled: true,
    isTest: true,
  },
  {
    key: "user-b",
    id: "mille-test-user-b",
    email: "test-b@mille.invalid",
    name: "テストユーザーB",
    imageUrl: null,
    isEnabled: true,
    isTest: true,
  },
] as const;

export type TestUser = (typeof TEST_USERS)[number];

export function findTestUser(key: unknown): TestUser | null {
  return TEST_USERS.find((user) => user.key === key) ?? null;
}

export function matchesTestIdentity(identity: { id?: string; email?: string | null }): boolean {
  return TEST_USERS.some((user) => user.id === identity.id
    && typeof identity.email === "string" && user.email === identity.email.trim().toLowerCase());
}

/** Reject partial fixture identities too, so a fixture cannot become a Google user. */
export function containsTestIdentity(identity: { id?: string; email?: string | null }): boolean {
  return TEST_USERS.some((user) => user.id === identity.id
    || (typeof identity.email === "string" && user.email === identity.email.trim().toLowerCase()));
}
