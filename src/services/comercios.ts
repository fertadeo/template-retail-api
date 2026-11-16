/** Singleton profile for the local installation. Legacy comercio_id columns remain internal. */
import type { RowDataPacket } from "mysql2/promise";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Comercio } from "../types.js";

type ComercioRow = RowDataPacket & {
  id: string; codigo: string; nombre: string; rubro: string; direccion: string;
  activa: number; es_default: number;
};
function mapComercio(row: ComercioRow): Comercio {
  return { id: row.id, codigo: row.codigo, nombre: row.nombre, rubro: row.rubro,
    direccion: row.direccion, activa: Boolean(row.activa), esDefault: Boolean(row.es_default) };
}

export async function getComercio(id: string): Promise<Comercio | null> {
  const rows = await query<ComercioRow[]>(
    `SELECT * FROM comercios WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? mapComercio(rows[0]) : null;
}

export async function getDefaultComercioId(): Promise<string> {
  const rows = await query<ComercioRow[]>(
    `SELECT * FROM comercios WHERE es_default = 1 AND activa = 1 LIMIT 1`
  );
  if (rows[0]) return rows[0].id;
  const any = await query<ComercioRow[]>(
    `SELECT * FROM comercios WHERE activa = 1 ORDER BY nombre ASC LIMIT 1`
  );
  if (!any[0]) throw new HttpError(500, "No hay un local configurado.");
  return any[0].id;
}

export async function resolveComercioId(
  _raw: string | null | undefined
): Promise<string> {
  return getDefaultComercioId();
}
