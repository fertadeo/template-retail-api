const { test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../dist/db/pool.js");
const { hashPassword, verifyPassword } = require("../dist/lib/password.js");
const users = new Map([
  [
    "admin",
    {
      id: "admin",
      nombre: "Admin",
      email: "admin@example.test",
      role: "superadmin",
      activa: 1,
      password_hash: hashPassword("Admin initial 123"),
    },
  ],
  [
    "seller",
    {
      id: "seller",
      nombre: "Seller",
      email: "seller@example.test",
      role: "vendedor",
      activa: 1,
      password_hash: hashPassword("Seller initial 123"),
    },
  ],
]);
// No database or HTTP server is used: only the authentication lifecycle is exercised.
pool.query = async (sql, params) => {
  assert.match(sql, /FROM users/);
  const row = sql.includes("WHERE email")
    ? [...users.values()].find((user) => user.email === params[0])
    : users.get(params[0]);
  return row ? [{ ...row }] : [];
};
pool.execute = async (sql, params) => {
  assert.match(sql, /UPDATE users SET password_hash/);
  const [hash, id, expected] = params;
  const user = users.get(id);
  if (!user?.activa || user.password_hash !== expected)
    return { affectedRows: 0 };
  user.password_hash = hash;
  return { affectedRows: 1 };
};
const auth = require("../dist/lib/auth.js");
const cookieName = "aurix_session";
async function call(handler, { path, method = "GET", token = "", body = {} }) {
  const req = {
    path,
    method,
    body,
    ip: "127.0.0.1",
    headers: { cookie: token ? `${cookieName}=${token}` : "" },
  };
  const res = {
    statusCode: 200,
    body: null,
    locals: {},
    token: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    setHeader() {},
    cookie(name, value) {
      assert.equal(name, cookieName);
      this.token = value;
    },
    clearCookie() {},
  };
  let next = false;
  await auth.requireSession(req, res, () => {
    next = true;
  });
  if (next) await handler(req, res);
  return res;
}
const inspect = (_req, res) =>
  res.json({ user: res.locals.user, actor: res.locals.actor });
async function login(email, password) {
  const result = await call(auth.login, {
    path: "/auth/login",
    method: "POST",
    body: { email, password },
  });
  assert.equal(result.statusCode, 200);
  assert.ok(result.token);
  return result.token;
}
test("own password changes rotate sessions; superadmin preview remains independent and read-only", async () => {
  const adminToken = await login("admin@example.test", "Admin initial 123");
  const sellerToken = await login("seller@example.test", "Seller initial 123");
  const sellerSecondToken = await login(
    "seller@example.test",
    "Seller initial 123",
  );
  const forbidden = await call(auth.startViewAs, {
    path: "/auth/view-as",
    method: "POST",
    token: sellerToken,
    body: { userId: "admin" },
  });
  assert.equal(forbidden.statusCode, 403);
  const started = await call(auth.startViewAs, {
    path: "/auth/view-as",
    method: "POST",
    token: adminToken,
    body: { userId: "seller" },
  });
  assert.equal(started.statusCode, 200);
  let view = await call(inspect, { path: "/auth/session", token: adminToken });
  assert.equal(view.body.user.id, "seller");
  assert.equal(view.body.actor.id, "admin");
  for (const [path, method] of [
    ["/auth/profile", "PATCH"],
    ["/auth/password", "PUT"],
    ["/users/seller", "PATCH"],
    ["/orders", "POST"],
  ]) {
    let reached = false;
    const blocked = await call(
      () => {
        reached = true;
      },
      { path, method, token: adminToken },
    );
    assert.equal(blocked.statusCode, 403);
    assert.equal(reached, false);
  }
  const adminHash = users.get("admin").password_hash;
  const changed = await call(auth.changeOwnPassword, {
    path: "/auth/password",
    method: "PUT",
    token: sellerToken,
    body: {
      currentPassword: "Seller initial 123",
      newPassword: " Seller new password 123 ",
      userId: "admin",
    },
  });
  assert.equal(changed.statusCode, 200);
  assert.ok(changed.token);
  assert.notEqual(changed.token, sellerToken);
  assert.equal(
    users.get("admin").password_hash,
    adminHash,
    "body userId cannot change another account",
  );
  assert.ok(
    verifyPassword(
      " Seller new password 123 ",
      users.get("seller").password_hash,
    ),
    "password whitespace is preserved",
  );
  for (const token of [sellerToken, sellerSecondToken]) {
    assert.equal(
      (await call(inspect, { path: "/auth/session", token })).statusCode,
      401,
    );
  }
  view = await call(inspect, { path: "/auth/session", token: adminToken });
  assert.equal(view.statusCode, 200);
  assert.equal(
    view.body.user.id,
    "seller",
    "seller password rotation must not break superadmin preview",
  );
  const wrong = await call(auth.changeOwnPassword, {
    path: "/auth/password",
    method: "PUT",
    token: changed.token,
    body: {
      currentPassword: "incorrect",
      newPassword: "A different password 123",
    },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(
    (await call(inspect, { path: "/auth/session", token: changed.token }))
      .statusCode,
    200,
    "wrong current password does not sign the user out",
  );
  users.get("seller").activa = 0;
  assert.equal(
    (
      await call(() => assert.fail("preview write allowed"), {
        path: "/orders",
        method: "POST",
        token: adminToken,
      })
    ).statusCode,
    403,
    "inactive preview remains read-only",
  );
  const stopped = await call(auth.stopViewAs, {
    path: "/auth/view-as/stop",
    method: "POST",
    token: adminToken,
  });
  assert.equal(stopped.statusCode, 200);
  const original = await call(inspect, {
    path: "/auth/session",
    token: adminToken,
  });
  assert.equal(original.body.user.id, "admin");
  assert.equal(original.body.actor, null);
  users.get("seller").activa = 1;
  await call(auth.startViewAs, {
    path: "/auth/view-as",
    method: "POST",
    token: adminToken,
    body: { userId: "seller" },
  });
  users.get("admin").password_hash = hashPassword("Admin reset 456");
  assert.equal(
    (await call(inspect, { path: "/auth/session", token: adminToken }))
      .statusCode,
    401,
    "revoking the original superadmin credentials revokes preview",
  );
});

test("account-management writes cannot escalate seller or administrator permissions", async () => {
  async function guard(role, path, body = {}, method = "PATCH") {
    const res = {
      locals: { user: { role } },
      statusCode: 200,
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    let passed = false;
    await auth.requireAccountManager({ method, path, body }, res, () => {
      passed = true;
    });
    return { ...res, passed };
  }
  assert.equal(
    (await guard("vendedor", "/admin", { role: "superadmin" })).statusCode,
    403,
  );
  assert.equal(
    (await guard("visitante", "/seller", { password: "reset" })).statusCode,
    403,
  );
  assert.equal(
    (await guard("administrador", "/", { role: "superadmin" })).statusCode,
    403,
  );
  assert.equal(
    (await guard("administrador", "/admin", { role: "vendedor" })).statusCode,
    403,
  );
  assert.equal(
    (await guard("administrador", "/seller", { role: "vendedor" })).passed,
    true,
  );
  for (const role of ["vendedor", "visitante", "administrador"]) {
    assert.equal(
      (await guard("administrador", "/", { role }, "POST")).passed,
      true,
      `administrador can create ${role}`,
    );
  }
  assert.equal(
    (await guard("administrador", "/", { role: "superadmin" }, "POST"))
      .statusCode,
    403,
  );
  assert.equal(
    (await guard("administrador", "/seller", { role: "administrador" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await guard("vendedor", "/", { role: "vendedor" }, "POST")).statusCode,
    403,
  );
  assert.equal(
    (await guard("superadmin", "/seller", { role: "administrador" })).passed,
    true,
  );
});
