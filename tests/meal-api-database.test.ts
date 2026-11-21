import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseConfiguration } from "../lib/server/database/environment";
import type { MealDetail } from "../lib/shared/meal-types";
import { TEST_USERS } from "../lib/shared/test-users";
import { disableUserSql, migrationSql, seedSql } from "../scripts/db/sql";

const preview: DatabaseConfiguration = { mode: "hosted", url: "", host: "", environment: "preview", environmentId: "mille-preview" };
const [owner, member] = TEST_USERS;
const workspaceId = "family-workspace";
const anotherWorkspaceId = "other-workspace";

type CommandResult = { ok: true; data: MealDetail | null } | { ok: false; status: number; code: string; currentVersion?: number };

function mealInput(mealDate = "2026-11-10") {
  return {
    mealDate, mealType: "DINNER", servings: 2,
    dishes: [{
      name: "鮭のホイル焼き", servings: null, recipeText: "包んで蒸す。", recipeUrl: null,
      ingredients: [{ name: "玉ねぎ", amountText: "1/2", unit: "個" }],
    }],
  };
}

async function fixture(t: TestContext) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(migrationSql(preview, true));
  await database.exec(seedSql(preview));
  await database.query(`
    INSERT INTO workspaces (id, name, type, created_by) VALUES
      ($1, '家族の献立', 'SHARED', $3), ($2, '個人の献立', 'PERSONAL', $3)
  `, [workspaceId, anotherWorkspaceId, owner.id]);
  await database.query(`
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ($1, $3, 'OWNER'), ($1, $4, 'MEMBER'), ($2, $3, 'OWNER')
  `, [workspaceId, anotherWorkspaceId, owner.id, member.id]);

  const write = async (operation: string, key: string, fields: object, actor: (typeof TEST_USERS)[number] = owner, workspace = workspaceId) => {
    const payload = JSON.stringify({ ...fields, workspaceId: workspace });
    const hash = createHash("sha256").update(JSON.stringify([operation, payload])).digest("hex");
    const { rows } = await database.query<{ result: CommandResult }>(
      "SELECT mille_meal_command_idempotent($1, $2, $3, $4::jsonb, $5, $6) AS result",
      [actor.id, actor.email, operation, payload, key, hash],
    );
    return rows[0].result;
  };

  return { database, write };
}

function mealFrom(result: CommandResult): MealDetail {
  assert.ok(result.ok && result.data);
  return result.data;
}

function assertError(result: CommandResult, status: number, code: string) {
  assert.ok(!result.ok);
  assert.equal(result.status, status);
  assert.equal(result.code, code);
}

test("a saved result has a 24-hour replay window, including a successful deletion", async t => {
  const { database, write } = await fixture(t);
  const attempts = await Promise.all([
    write("create", "create", mealInput()),
    write("create", "create", mealInput()),
  ]);
  const meal = mealFrom(attempts[0]);
  assert.deepEqual(attempts[0], attempts[1]);

  const deletion = { mealId: meal.id, expectedVersion: meal.version };
  assert.deepEqual(await write("delete", "delete", deletion), { ok: true, data: null });
  assert.deepEqual(await write("delete", "delete", deletion), { ok: true, data: null });
  assert.deepEqual(await write("create", "create", mealInput()), attempts[0]);
  assertError(await write("delete", "new-delete", deletion), 404, "NOT_FOUND");
  assertError(await write("create", "delete", mealInput()), 409, "IDEMPOTENCY_KEY_REUSED");

  const requests = await database.query<{ hours: number }>(
    "SELECT (EXTRACT(epoch FROM expires_at - created_at) / 3600)::int AS hours FROM meal_command_requests ORDER BY request_key",
  );
  assert.deepEqual(requests.rows, [{ hours: 24 }, { hours: 24 }]);
  await database.exec("UPDATE meal_command_requests SET expires_at = clock_timestamp() - interval '1 second'");
  assertError(await write("delete", "delete", deletion), 404, "NOT_FOUND");
  const recorded = mealFrom(await write("create", "create", mealInput()));
  assert.notEqual(recorded.id, meal.id);
  assert.deepEqual((await database.query("SELECT request_key FROM meal_command_requests")).rows, [{ request_key: "create" }]);
});

test("replay keys are scoped to actor and workspace, and current access is still required", async t => {
  const { database, write } = await fixture(t);
  const ownerMeal = mealFrom(await write("create", "same-key", mealInput()));
  const memberMeal = mealFrom(await write("create", "same-key", mealInput("2026-11-11"), member));
  const otherMeal = mealFrom(await write("create", "same-key", mealInput(), owner, anotherWorkspaceId));
  assert.equal(ownerMeal.updatedBy.id, owner.id);
  assert.equal(memberMeal.updatedBy.id, member.id);
  assert.equal(otherMeal.workspaceId, anotherWorkspaceId);
  await database.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, member.id]);
  assertError(await write("create", "same-key", mealInput("2026-11-11"), member), 404, "NOT_FOUND");
  await database.exec(disableUserSql(preview, owner.id));
  assertError(await write("create", "same-key", mealInput()), 401, "UNAUTHENTICATED");
});

test("a failure to persist replay data rolls back the meal and all children", async t => {
  const { database, write } = await fixture(t);
  await database.exec("ALTER TABLE meal_command_requests ADD CONSTRAINT reject_fixture_key CHECK (request_key <> 'failure')");
  await assert.rejects(write("create", "failure", mealInput()), /reject_fixture_key/);
  assert.deepEqual((await database.query(`SELECT
    (SELECT count(*)::int FROM meals) AS meals,
    (SELECT count(*)::int FROM meal_dishes) AS dishes,
    (SELECT count(*)::int FROM dish_ingredients) AS ingredients,
    (SELECT count(*)::int FROM meal_command_requests) AS requests
  `)).rows, [{ meals: 0, dishes: 0, ingredients: 0, requests: 0 }]);
  mealFrom(await write("create", "new-key", mealInput()));
  assertError(await write("create", "new-attempt", mealInput()), 409, "SLOT_OCCUPIED");
  mealFrom(await write("create", "new-attempt", mealInput("2026-11-11")));
});
