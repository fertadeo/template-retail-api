import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId, slugCodigo } from "../lib/ids.js";
import type { PriceList } from "../types.js";
import { getDefaultComercioId } from "./comercios.js";

type PlRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  nombre: string;
  codigo: string;
  activa: number;
  es_default: number;
};

function map(row: PlRow): PriceList {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    nombre: row.nombre,
    codigo: row.codigo,
    activa: Boolean(row.activa),
    esDefault: Boolean(row.es_default),
  };
}

export async function listPriceLists(
  onlyActive = false,
  comercioId?: string
): Promise<PriceList[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const sql = onlyActive
    ? `SELECT * FROM price_lists WHERE comercio_id = ? AND activa = 1 ORDER BY es_default DESC, nombre ASC`
    : `SELECT * FROM price_lists WHERE comercio_id = ? ORDER BY es_default DESC, nombre ASC`;
  const rows = await query<PlRow[]>(sql, [cid]);
  return rows.map(map);
}

export async function getPriceList(id: string): Promise<PriceList | null> {
  const rows = await query<PlRow[]>(
    `SELECT * FROM price_lists WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function getDefaultPriceListId(
  comercioId?: string
): Promise<string> {
  const cid = comercioId || (await getDefaultComercioId());
  const rows = await query<PlRow[]>(
    `SELECT * FROM price_lists
     WHERE comercio_id = ? AND es_default = 1 AND activa = 1 LIMIT 1`,
    [cid]
  );
  if (rows[0]) return rows[0].id;
  const any = await query<PlRow[]>(
    `SELECT * FROM price_lists WHERE comercio_id = ? AND activa = 1 ORDER BY nombre ASC LIMIT 1`,
    [cid]
  );
  if (!any[0]) throw new HttpError(400, "No hay listas de precios activas.");
  return any[0].id;
}

export async function createPriceList(input: {
  nombre: string;
  codigo?: string;
  activa?: boolean;
  esDefault?: boolean;
  comercioId?: string;
}): Promise<PriceList> {
  const nombre = input.nombre.trim();
  if (!nombre) throw new HttpError(400, "El nombre es obligatorio.");
  const codigo = (input.codigo?.trim() || slugCodigo(nombre)).slice(0, 64);
  const id = nextId("pl");
  const activa = input.activa !== false ? 1 : 0;
  const esDefault = input.esDefault ? 1 : 0;
  const comercioId = input.comercioId || (await getDefaultComercioId());

  await withTransaction(async (conn) => {
    if (esDefault) {
      await conn.execute(
        `UPDATE price_lists SET es_default = 0 WHERE comercio_id = ?`,
        [comercioId]
      );
    }
    await conn.execute(
      `INSERT INTO price_lists (id, comercio_id, nombre, codigo, activa, es_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, comercioId, nombre, codigo, activa, esDefault]
    );
  });

  const created = await getPriceList(id);
  if (!created) throw new HttpError(500, "No se pudo crear la lista.");
  return created;
}

export async function updatePriceList(
  id: string,
  input: Partial<{
    nombre: string;
    codigo: string;
    activa: boolean;
    esDefault: boolean;
  }>
): Promise<PriceList> {
  const current = await getPriceList(id);
  if (!current) throw new HttpError(404, "Lista no encontrada.");

  const nombre = input.nombre?.trim() ?? current.nombre;
  const codigo = input.codigo?.trim() ?? current.codigo;
  const activa =
    input.activa !== undefined ? (input.activa ? 1 : 0) : current.activa ? 1 : 0;
  const esDefault =
    input.esDefault !== undefined
      ? input.esDefault
        ? 1
        : 0
      : current.esDefault
        ? 1
        : 0;

  if (!nombre) throw new HttpError(400, "El nombre es obligatorio.");

  await withTransaction(async (conn) => {
    if (esDefault && current.comercioId) {
      await conn.execute(
        `UPDATE price_lists SET es_default = 0 WHERE comercio_id = ?`,
        [current.comercioId]
      );
    }
    const [result] = await conn.execute<ResultSetHeader>(
      `UPDATE price_lists
       SET nombre = ?, codigo = ?, activa = ?, es_default = ?
       WHERE id = ?`,
      [nombre, codigo, activa, esDefault, id]
    );
    if (result.affectedRows === 0) {
      throw new HttpError(404, "Lista no encontrada.");
    }
  });

  const updated = await getPriceList(id);
  if (!updated) throw new HttpError(404, "Lista no encontrada.");
  return updated;
}

export async function setDefaultPriceList(id: string): Promise<PriceList> {
  return updatePriceList(id, { esDefault: true, activa: true });
}

export async function ensureActiveList(id: string): Promise<PriceList> {
  const list = await getPriceList(id);
  if (!list || !list.activa) {
    throw new HttpError(400, "Lista de precios inexistente o inactiva.");
  }
  return list;
}
