import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId, slugCodigo } from "../lib/ids.js";
import { getDefaultComercioId } from "./comercios.js";

export type Category = {
  id: string;
  comercioId: string;
  codigo: string;
  nombre: string;
  activa: boolean;
};

type CatRow = RowDataPacket & {
  id: string;
  comercio_id: string;
  codigo: string;
  nombre: string;
  activa: number;
};

function map(row: CatRow): Category {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    codigo: row.codigo,
    nombre: row.nombre,
    activa: Boolean(row.activa),
  };
}

export async function listCategories(
  onlyActive = false,
  comercioId?: string
): Promise<Category[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const sql = onlyActive
    ? `SELECT * FROM categories WHERE comercio_id = ? AND activa = 1 ORDER BY nombre ASC`
    : `SELECT * FROM categories WHERE comercio_id = ? ORDER BY activa DESC, nombre ASC`;
  const rows = await query<CatRow[]>(sql, [cid]);
  return rows.map(map);
}

export async function getCategory(id: string): Promise<Category | null> {
  const rows = await query<CatRow[]>(
    `SELECT * FROM categories WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function getCategoryByCodigo(
  comercioId: string,
  codigo: string
): Promise<Category | null> {
  const rows = await query<CatRow[]>(
    `SELECT * FROM categories WHERE comercio_id = ? AND codigo = ? LIMIT 1`,
    [comercioId, codigo]
  );
  return rows[0] ? map(rows[0]) : null;
}

async function uniqueCodigo(comercioId: string, base: string): Promise<string> {
  let codigo = base || "categoria";
  let n = 2;
  while (await getCategoryByCodigo(comercioId, codigo)) {
    const suffix = `-${n}`;
    codigo = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    n += 1;
  }
  return codigo;
}

export async function createCategory(input: {
  comercioId: string;
  nombre: string;
  codigo?: string;
}): Promise<Category> {
  const nombre = input.nombre.trim();
  if (!nombre) throw new HttpError(400, "El nombre de la categoría es obligatorio.");
  const base = slugCodigo(input.codigo?.trim() || nombre).replace(/-/g, "_");
  const codigo = await uniqueCodigo(input.comercioId, base.slice(0, 64) || "categoria");
  const id = nextId("cat");
  await execute(
    `INSERT INTO categories (id, comercio_id, codigo, nombre, activa)
     VALUES (?, ?, ?, ?, 1)`,
    [id, input.comercioId, codigo, nombre.slice(0, 120)]
  );
  const saved = await getCategory(id);
  if (!saved) throw new HttpError(500, "No se pudo crear la categoría.");
  return saved;
}

export async function updateCategory(
  id: string,
  input: { nombre?: string; activa?: boolean }
): Promise<Category> {
  const current = await getCategory(id);
  if (!current) throw new HttpError(404, "Categoría no encontrada.");
  const nombre = input.nombre?.trim() || current.nombre;
  if (!nombre) throw new HttpError(400, "El nombre de la categoría es obligatorio.");
  const activa = input.activa === undefined ? current.activa : input.activa;
  await execute(
    `UPDATE categories SET nombre = ?, activa = ? WHERE id = ?`,
    [nombre.slice(0, 120), activa ? 1 : 0, id]
  );
  const saved = await getCategory(id);
  if (!saved) throw new HttpError(404, "Categoría no encontrada.");
  return saved;
}

/** Acepta el código si existe. En un alta tiene que estar activa. */
export async function assertCategoryCodigo(
  comercioId: string,
  codigo: string,
  opts?: { allowInactive?: boolean }
): Promise<Category> {
  const code = codigo.trim();
  if (!code) throw new HttpError(400, "Elegí una categoría.");
  const cat = await getCategoryByCodigo(comercioId, code);
  if (!cat) throw new HttpError(400, "Elegí una categoría existente.");
  if (!cat.activa && !opts?.allowInactive) {
    throw new HttpError(400, "Esa categoría está archivada. Elegí otra.");
  }
  return cat;
}
