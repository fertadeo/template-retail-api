import { randomBytes, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { query } from "../db/pool.js";
import { verifyPassword, hashPassword } from "./password.js";

const COOKIE = "aurix_session";
const TTL = 8 * 60 * 60 * 1000;
// Single-process installation: restarting the API deliberately expires sessions.
const sessions = new Map<string, { userId: string; passwordHash: string; expires: number }>();
const attempts = new Map<string, { count: number; expires: number }>();
const dummyHash = hashPassword(randomBytes(32).toString("hex"));
type AuthUser = RowDataPacket & {
  id: string; email: string; nombre: string; role: string; activa: number; password_hash: string;
};

function sessionKey(req: Request) {
  const value = (req.headers.cookie ?? "").split(";").map(v => v.trim())
    .find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value ? createHash("sha256").update(value).digest("hex") : "";
}
function clearExpired() {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
}
function cookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
}
export async function sessionUser(req: Request) {
  clearExpired();
  const key = sessionKey(req);
  const session = sessions.get(key);
  if (!session) return null;
  const rows = await query<AuthUser[]>(
    "SELECT id, email, nombre, role, activa, password_hash FROM users WHERE id = ? LIMIT 1", [session.userId]
  );
  const user = rows[0];
  if (!user?.activa || user.password_hash !== session.passwordHash) {
    sessions.delete(key);
    return null;
  }
  return { id: user.id, email: user.email, nombre: user.nombre, role: user.role };
}
export async function login(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || email.length > 254 || !password || password.length > 1024) {
    res.status(400).json({ error: "Ingresá email y contraseña." }); return;
  }
  clearExpired();
  const key = req.ip ?? "unknown";
  const attempt = attempts.get(key) ?? { count: 0, expires: Date.now() + 15 * 60 * 1000 };
  if (attempt.count >= 30) {
    res.status(429).json({ error: "Demasiados intentos. Volvé a intentar en 15 minutos." }); return;
  }
  attempt.count++;
  attempts.set(key, attempt);
  const rows = await query<AuthUser[]>(
    "SELECT id, email, nombre, role, activa, password_hash FROM users WHERE email = ? LIMIT 1", [email]
  );
  const user = rows[0];
  const valid = verifyPassword(password, user?.password_hash || dummyHash);
  if (!valid || !user?.activa) {
    res.status(401).json({ error: "Email o contraseña incorrectos." }); return;
  }
  sessions.delete(sessionKey(req));
  if (sessions.size >= 10000) { res.status(503).json({ error: "No se pudo iniciar sesión. Intentá más tarde." }); return; }
  const token = randomBytes(32).toString("hex");
  sessions.set(createHash("sha256").update(token).digest("hex"), {
    userId: user.id, passwordHash: user.password_hash, expires: Date.now() + TTL,
  });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: TTL });
  res.json({ user: { id: user.id, email: user.email, nombre: user.nombre, role: user.role } });
}
export function logout(req: Request, res: Response) {
  sessions.delete(sessionKey(req));
  res.clearCookie(COOKIE, cookieOptions());
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
}
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const publicRoute = req.path === "/health" || req.path === "/auth/login" || req.path === "/auth/logout"
    || req.path === "/catalog/public" || req.path.startsWith("/catalog/public/")
    || (req.method === "POST" && req.path === "/channels/mercadolibre/notifications")
    || (req.method === "GET" && req.path === "/channels/mercadolibre/notifications/callback");
  if (publicRoute) { next(); return; }
  try {
    res.setHeader("Cache-Control", "no-store");
    const user = await sessionUser(req);
    if (!user) { res.status(401).json({ error: "Iniciá sesión para continuar." }); return; }
    res.locals.user = user;
    next();
  } catch (err) { next(err); }
}
