import { randomBytes, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { verifyPassword, hashPassword } from "./password.js";

const COOKIE = "aurix_session";
const TTL = 8 * 60 * 60 * 1000;
// Single-process installation: restarting the API deliberately expires sessions.
const sessions = new Map<
  string,
  {
    userId: string;
    passwordHash: string;
    expires: number;
    previewUserId?: string;
  }
>();
const attempts = new Map<string, { count: number; expires: number }>();
const dummyHash = hashPassword(randomBytes(32).toString("hex"));
type AuthUser = RowDataPacket & {
  id: string;
  email: string;
  nombre: string;
  role: string;
  activa: number;
  password_hash: string;
};

function sessionKey(req: Request) {
  const value = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return value ? createHash("sha256").update(value).digest("hex") : "";
}
function clearExpired() {
  const now = Date.now();
  for (const [key, value] of sessions)
    if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of attempts)
    if (value.expires <= now) attempts.delete(key);
}
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}
export async function sessionUser(req: Request) {
  clearExpired();
  const key = sessionKey(req);
  const session = sessions.get(key);
  if (!session) return null;
  const rows = await query<AuthUser[]>(
    "SELECT id, email, nombre, role, activa, password_hash FROM users WHERE id = ? LIMIT 1",
    [session.userId],
  );
  const user = rows[0];
  if (!user?.activa || user.password_hash !== session.passwordHash) {
    sessions.delete(key);
    return null;
  }
  const actor = {
    id: user.id,
    email: user.email,
    nombre: user.nombre,
    role: user.role,
  };
  if (session.previewUserId) {
    if (user.role !== "superadmin") return { ...actor, actor };
    const targets = await query<AuthUser[]>(
      "SELECT id, email, nombre, role, activa FROM users WHERE id = ? LIMIT 1",
      [session.previewUserId],
    );
    const target = targets[0];
    if (!target?.activa) return { ...actor, actor };
    return {
      id: target.id,
      email: target.email,
      nombre: target.nombre,
      role: target.role,
      actor,
    };
  }
  return { ...actor, actor: null };
}
export async function login(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || email.length > 254 || !password || password.length > 1024) {
    res.status(400).json({ error: "Ingresá email y contraseña." });
    return;
  }
  clearExpired();
  const key = req.ip ?? "unknown";
  const attempt = attempts.get(key) ?? {
    count: 0,
    expires: Date.now() + 15 * 60 * 1000,
  };
  if (attempt.count >= 30) {
    res
      .status(429)
      .json({ error: "Demasiados intentos. Volvé a intentar en 15 minutos." });
    return;
  }
  attempt.count++;
  attempts.set(key, attempt);
  const rows = await query<AuthUser[]>(
    "SELECT id, email, nombre, role, activa, password_hash FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  const user = rows[0];
  const valid = verifyPassword(password, user?.password_hash || dummyHash);
  if (!valid || !user?.activa) {
    res.status(401).json({ error: "Email o contraseña incorrectos." });
    return;
  }
  sessions.delete(sessionKey(req));
  if (sessions.size >= 10000) {
    res
      .status(503)
      .json({ error: "No se pudo iniciar sesión. Intentá más tarde." });
    return;
  }
  const token = randomBytes(32).toString("hex");
  sessions.set(createHash("sha256").update(token).digest("hex"), {
    userId: user.id,
    passwordHash: user.password_hash,
    expires: Date.now() + TTL,
  });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: TTL });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      nombre: user.nombre,
      role: user.role,
    },
  });
}
export function logout(req: Request, res: Response) {
  sessions.delete(sessionKey(req));
  res.clearCookie(COOKIE, cookieOptions());
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
}
export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const publicRoute =
    req.path === "/health" ||
    req.path === "/auth/login" ||
    req.path === "/auth/logout";
  if (publicRoute) {
    next();
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    const user = await sessionUser(req);
    if (!user) {
      res.status(401).json({ error: "Iniciá sesión para continuar." });
      return;
    }
    const { actor, ...effectiveUser } = user;
    res.locals.user = effectiveUser;
    res.locals.actor = actor;
    const previewControl =
      req.method === "POST" &&
      ["/auth/view-as", "/auth/view-as/stop", "/auth/logout"].includes(
        req.path,
      );
    if (
      actor &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !previewControl
    ) {
      res
        .status(403)
        .json({
          error:
            "Estás viendo otra cuenta en modo solo lectura. Volvé a tu cuenta para realizar cambios.",
        });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** The original superadmin session remains the authority; target passwords are never used. */
export async function startViewAs(req: Request, res: Response) {
  const actor = res.locals.actor ?? res.locals.user;
  if (actor?.role !== "superadmin") {
    res.status(403).json({ error: "Solo el superadmin puede usar Ver como." });
    return;
  }
  const id = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (!id || id.length > 40 || id === actor.id) {
    res.status(400).json({ error: "Elegí otra cuenta activa." });
    return;
  }
  const users = await query<AuthUser[]>(
    "SELECT id, activa FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  if (!users[0]?.activa) {
    res.status(404).json({ error: "La cuenta no está disponible." });
    return;
  }
  const session = sessions.get(sessionKey(req));
  if (!session) {
    res.status(401).json({ error: "Iniciá sesión para continuar." });
    return;
  }
  session.previewUserId = id;
  res.json({ ok: true });
}
export function stopViewAs(req: Request, res: Response) {
  const session = sessions.get(sessionKey(req));
  if (session) delete session.previewUserId;
  res.json({ ok: true });
}
export async function changeOwnPassword(req: Request, res: Response) {
  if (res.locals.actor) {
    res
      .status(403)
      .json({ error: "Volvé a tu cuenta para cambiar la contraseña." });
    return;
  }
  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;
  if (
    typeof currentPassword !== "string" ||
    !currentPassword ||
    currentPassword.length > 1024 ||
    typeof newPassword !== "string" ||
    newPassword.trim().length < 8 ||
    newPassword.length > 128
  ) {
    res
      .status(400)
      .json({
        error:
          "Ingresá tu contraseña actual y una nueva de entre 8 y 128 caracteres.",
      });
    return;
  }
  if (currentPassword === newPassword) {
    res
      .status(400)
      .json({ error: "La nueva contraseña debe ser diferente de la actual." });
    return;
  }
  clearExpired();
  const id = res.locals.user.id as string;
  const attemptKey = `password:${id}`;
  const attempt = attempts.get(attemptKey) ?? {
    count: 0,
    expires: Date.now() + 15 * 60 * 1000,
  };
  if (attempt.count >= 10) {
    res
      .status(429)
      .json({ error: "Demasiados intentos. Volvé a intentar en 15 minutos." });
    return;
  }
  if (attempts.size >= 10000 && !attempts.has(attemptKey)) {
    res.status(429).json({ error: "Volvé a intentar más tarde." });
    return;
  }
  attempt.count++;
  attempts.set(attemptKey, attempt);
  const rows = await query<AuthUser[]>(
    "SELECT id, password_hash, activa FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  const user = rows[0];
  if (!user?.activa || !verifyPassword(currentPassword, user.password_hash)) {
    res.status(400).json({ error: "La contraseña actual no es correcta." });
    return;
  }
  const passwordHash = hashPassword(newPassword);
  const result = await execute(
    "UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND password_hash = ? AND activa = 1",
    [passwordHash, id, user.password_hash],
  );
  if (result.affectedRows !== 1) {
    res
      .status(409)
      .json({ error: "La cuenta cambió. Volvé a iniciar sesión." });
    return;
  }
  // Close all prior sessions, then keep this browser signed in using a fresh token.
  for (const [key, session] of sessions)
    if (session.userId === id) sessions.delete(key);
  const token = randomBytes(32).toString("hex");
  sessions.set(createHash("sha256").update(token).digest("hex"), {
    userId: id,
    passwordHash,
    expires: Date.now() + TTL,
  });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: TTL });
  attempts.delete(attemptKey);
  res.json({ ok: true });
}

export async function requireAccountManager(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const role = res.locals.user?.role;
  if (!["superadmin", "administrador"].includes(role)) {
    res
      .status(403)
      .json({ error: "No tenés permiso para administrar cuentas." });
    return;
  }
  if (role === "administrador") {
    if (req.body?.role && !["vendedor", "visitante"].includes(req.body.role)) {
      res
        .status(403)
        .json({
          error:
            "Solo el superadmin puede administrar cuentas de administradores.",
        });
      return;
    }
    const id = req.path.split("/").filter(Boolean)[0];
    if (id) {
      const rows = await query<AuthUser[]>(
        "SELECT role FROM users WHERE id = ? LIMIT 1",
        [id],
      );
      if (rows[0] && !["vendedor", "visitante"].includes(rows[0].role)) {
        res
          .status(403)
          .json({ error: "Solo el superadmin puede modificar esta cuenta." });
        return;
      }
    }
  }
  next();
}
