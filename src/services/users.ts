import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  APP_FUNCTIONS,
  isAppFunctionCode,
  type AppFunctionCode,
} from "../lib/app-functions.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import { hashPassword } from "../lib/password.js";
import { execute, query, withTransaction } from "../db/pool.js";
import type { User, UserRole } from "../types.js";

type UserRow = RowDataPacket & {
  id: string;
  email: string;
  nombre: string;
  role: UserRole;
  activa: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const ROLES: UserRole[] = [
  "superadmin",
  "administrador",
  "vendedor",
  "visitante",
];

function isRole(value: string): value is UserRole {
  return (ROLES as string[]).includes(value);
}

function mapUser(
  row: UserRow,
  branchIds: string[],
  functions: AppFunctionCode[]
): User {
  return {
    id: row.id,
    email: row.email,
    nombre: row.nombre,
    role: row.role,
    activa: Boolean(row.activa),
    branchIds,
    functions,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

async function loadBranchIds(userId: string): Promise<string[]> {
  const rows = await query<(RowDataPacket & { branch_id: string })[]>(
    `SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id`,
    [userId]
  );
  return rows.map((r) => r.branch_id);
}

async function loadFunctions(userId: string): Promise<AppFunctionCode[]> {
  const rows = await query<(RowDataPacket & { function_code: string })[]>(
    `SELECT function_code FROM user_functions WHERE user_id = ? ORDER BY function_code`,
    [userId]
  );
  return rows
    .map((r) => r.function_code)
    .filter(isAppFunctionCode);
}

async function hydrate(row: UserRow): Promise<User> {
  const [branchIds, functions] = await Promise.all([
    loadBranchIds(row.id),
    loadFunctions(row.id),
  ]);
  return mapUser(row, branchIds, functions);
}

export async function listUsers(onlyActive = false): Promise<User[]> {
  const rows = await query<UserRow[]>(
    onlyActive
      ? `SELECT id, email, nombre, role, activa, created_at, updated_at
         FROM users WHERE activa = 1 ORDER BY nombre ASC`
      : `SELECT id, email, nombre, role, activa, created_at, updated_at
         FROM users ORDER BY nombre ASC`
  );
  return Promise.all(rows.map(hydrate));
}

export async function getUser(id: string): Promise<User | null> {
  const rows = await query<UserRow[]>(
    `SELECT id, email, nombre, role, activa, created_at, updated_at
     FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return hydrate(rows[0]);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeFunctions(raw: string[] | undefined): AppFunctionCode[] {
  if (!raw?.length) return [];
  const out: AppFunctionCode[] = [];
  for (const code of raw) {
    if (!isAppFunctionCode(code)) {
      throw new HttpError(400, `Función desconocida: ${code}`);
    }
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Admin / superadmin / visitante no usan restricciones de sucursal ni función.
 * Solo el vendedor guarda branchIds y functions.
 */
function scopeForRole(
  role: UserRole,
  branchIds: string[] | undefined,
  functions: string[] | undefined
): { branchIds: string[]; functions: AppFunctionCode[] } {
  if (role !== "vendedor") {
    return { branchIds: [], functions: [] };
  }
  return {
    branchIds: [...new Set((branchIds ?? []).map((b) => b.trim()).filter(Boolean))],
    functions: normalizeFunctions(functions),
  };
}

export async function upsertUser(input: {
  id?: string;
  email: string;
  nombre: string;
  password?: string;
  role: UserRole;
  activa?: boolean;
  branchIds?: string[];
  functions?: string[];
}): Promise<User> {
  const email = normalizeEmail(input.email);
  const nombre = input.nombre.trim();
  if (!email || !nombre) {
    throw new HttpError(400, "Email y nombre son obligatorios.");
  }
  if (!email.includes("@")) {
    throw new HttpError(400, "Email inválido.");
  }
  if (!isRole(input.role)) {
    throw new HttpError(400, "Rol inválido.");
  }

  const id = input.id ?? nextId("usr");
  const isCreate = !input.id;
  if (isCreate && !input.password?.trim()) {
    throw new HttpError(400, "La contraseña es obligatoria al crear el usuario.");
  }
  if (input.password !== undefined && input.password.trim().length < 6) {
    throw new HttpError(400, "La contraseña debe tener al menos 6 caracteres.");
  }

  const scope = scopeForRole(input.role, input.branchIds, input.functions);
  // Sucursales opcionales: en installs por comercio-local el vendedor opera sin PBS.

  const dup = await query<(RowDataPacket & { id: string })[]>(
    `SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1`,
    [email, id]
  );
  if (dup[0]) {
    throw new HttpError(409, `Ya existe un usuario con el email "${email}".`);
  }

  await withTransaction(async (conn) => {
    if (scope.branchIds.length) {
      const ph = scope.branchIds.map(() => "?").join(",");
      const [found] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM branches WHERE id IN (${ph}) AND activa = 1`,
        scope.branchIds
      );
      if (found.length !== scope.branchIds.length) {
        throw new HttpError(
          400,
          "Una o más sucursales no existen o están inactivas."
        );
      }
    }

    if (input.id) {
      const sets = [
        "email = ?",
        "nombre = ?",
        "role = ?",
        "activa = ?",
      ];
      const params: Array<string | number> = [
        email,
        nombre,
        input.role,
        input.activa === false ? 0 : 1,
      ];
      if (input.password?.trim()) {
        sets.push("password_hash = ?");
        params.push(hashPassword(input.password.trim()));
      }
      params.push(id);
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Usuario no encontrado.");
      }
    } else {
      await conn.execute(
        `INSERT INTO users (id, email, nombre, password_hash, role, activa)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          email,
          nombre,
          hashPassword(input.password!.trim()),
          input.role,
          input.activa === false ? 0 : 1,
        ]
      );
    }

    await conn.execute(`DELETE FROM user_branches WHERE user_id = ?`, [id]);
    await conn.execute(`DELETE FROM user_functions WHERE user_id = ?`, [id]);

    for (const branchId of scope.branchIds) {
      await conn.execute(
        `INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)`,
        [id, branchId]
      );
    }
    for (const code of scope.functions) {
      await conn.execute(
        `INSERT INTO user_functions (user_id, function_code) VALUES (?, ?)`,
        [id, code]
      );
    }
  });

  const saved = await getUser(id);
  if (!saved) throw new HttpError(500, "No se pudo guardar el usuario.");
  return saved;
}

export async function softDeleteUser(id: string): Promise<User> {
  const current = await getUser(id);
  if (!current) throw new HttpError(404, "Usuario no encontrado.");
  if (!current.activa) {
    throw new HttpError(400, "El usuario ya está desactivado.");
  }
  if (current.role === "superadmin") {
    const activeAdmins = await query<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM users
       WHERE role = 'superadmin' AND activa = 1 AND id <> ?`,
      [id]
    );
    if ((activeAdmins[0]?.c ?? 0) < 1) {
      throw new HttpError(
        400,
        "No se puede desactivar el único superadmin activo."
      );
    }
  }
  await execute(`UPDATE users SET activa = 0 WHERE id = ?`, [id]);
  const saved = await getUser(id);
  if (!saved) throw new HttpError(404, "Usuario no encontrado.");
  return saved;
}

export async function restoreUser(id: string): Promise<User> {
  const current = await getUser(id);
  if (!current) throw new HttpError(404, "Usuario no encontrado.");
  if (current.activa) {
    throw new HttpError(400, "El usuario ya está activo.");
  }
  await execute(`UPDATE users SET activa = 1 WHERE id = ?`, [id]);
  const saved = await getUser(id);
  if (!saved) throw new HttpError(404, "Usuario no encontrado.");
  return saved;
}

/** Crea el superadmin de desarrollo si la tabla está vacía. */
export async function ensureSeedUsers(): Promise<void> {
  try {
    const rows = await query<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM users`
    );
    if ((rows[0]?.c ?? 0) > 0) return;

    const id = "usr_superadmin";
    await execute(
      `INSERT INTO users (id, email, nombre, password_hash, role, activa)
       VALUES (?, ?, ?, ?, 'superadmin', 1)`,
      [
        id,
        "superadmin@aurixerp.com",
        "Superadmin",
        hashPassword("aurix-dev-change-me"),
      ]
    );
    console.log(
      "[retail-360-api] seed user: superadmin@aurixerp.com (cambiar contraseña)"
    );
  } catch (err) {
    console.warn("[retail-360-api] ensureSeedUsers:", err);
  }
}

export function listAppFunctions() {
  return APP_FUNCTIONS.map((f) => ({ code: f.code, label: f.label }));
}
