const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.RETAIL_UTC_OFFSET_MINUTES = "-180";
const cash = require("../dist/services/cash.js");
test("cash balance excludes transfers and preserves cents", () => {
  assert.deepEqual(cash.cashBalance(1000.25, 200.55, 1200.8), {
    expected: 1200.8,
    difference: 0,
  });
  assert.deepEqual(cash.cashBalance(500, 100, 590), {
    expected: 600,
    difference: -10,
  });
});
test("business-day windows include local midnight and exclude the next midnight", () => {
  assert.deepEqual(cash.dateWindow("2026-11-21", "2026-11-21"), {
    start: "2026-11-21 03:00:00",
    end: "2026-11-22 03:00:00",
  });
  assert.equal(
    cash.businessDay(Date.parse("2026-11-21T02:59:59Z")),
    "2026-11-20",
  );
  assert.equal(
    cash.businessDay(Date.parse("2026-11-21T03:00:00Z")),
    "2026-11-21",
  );
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-11-22", "2026-11-21"],
    ["2024-01-01", "2026-01-01"],
  ])
    assert.throws(
      () => cash.dateWindow(from, to),
      (error) => error.status === 400,
    );
});
test("POS rejects a closed cash register and associates an open one under a row lock", async () => {
  const closed = {
    execute: async (sql) => {
      assert.match(sql, /FOR UPDATE/);
      return [[]];
    },
  };
  await assert.rejects(
    cash.requireOpenCash(closed, "shop-a"),
    (error) => error.status === 409,
  );
  const statements = [];
  const open = {
    execute: async (sql, params) => {
      statements.push({ sql, params });
      return sql.startsWith("SELECT")
        ? [[{ id: "register-a" }]]
        : [{ affectedRows: 1 }];
    },
  };
  assert.equal(await cash.requireOpenCash(open, "shop-a"), "register-a");
  assert.deepEqual(statements[0].params, ["shop-a"]);
  assert.match(statements[0].sql, /FOR UPDATE/);
  assert.deepEqual(statements[1].params, ["register-a"]);
});
test("cash close validates store, operator and the latest sale version before persisting", async () => {
  const pool = require("../dist/db/pool.js");
  const original = pool.withTransaction;
  let row = null;
  const writes = [];
  pool.withTransaction = async (callback) =>
    callback({
      execute: async (sql, params) => {
        if (sql.startsWith("SELECT * FROM cash_sessions")) {
          assert.deepEqual(params, ["register-a", "shop-a"]);
          return [row ? [row] : []];
        }
        writes.push(sql);
        throw new Error("Unexpected write before validation");
      },
    });
  try {
    await assert.rejects(
      cash.closeCash(
        "shop-a",
        { id: "seller", role: "vendedor" },
        "register-a",
        { counted: 0, version: 1, note: "" },
      ),
      (error) => error.status === 404,
    );
    row = { opened_by: "another", version: 2, closed_at: null };
    await assert.rejects(
      cash.closeCash(
        "shop-a",
        { id: "seller", role: "vendedor" },
        "register-a",
        { counted: 0, version: 1, note: "" },
      ),
      (error) => error.status === 403,
    );
    await assert.rejects(
      cash.closeCash(
        "shop-a",
        { id: "admin", role: "administrador" },
        "register-a",
        { counted: 0, version: 1, note: "" },
      ),
      (error) => error.status === 409,
    );
    row.closed_at = "2026-11-21";
    await assert.rejects(
      cash.closeCash(
        "shop-a",
        { id: "admin", role: "administrador" },
        "register-a",
        { counted: 0, version: 2, note: "" },
      ),
      (error) => error.status === 409,
    );
    assert.equal(writes.length, 0);
  } finally {
    pool.withTransaction = original;
  }
});
