import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type { Branch } from "../types.js";

type BranchRow = RowDataPacket & {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  rubro: string;
  activa: number;
  es_default: number;
  comercio_id?: string | null;
};

function mapBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    direccion: row.direccion ?? "",
    rubro: row.rubro ?? "",
    activa: Boolean(row.activa),
    esDefault: Boolean(row.es_default),
    comercioId: row.comercio_id ?? null,
  };
}

export async function listBranches(onlyActive = false): Promise<Branch[]> {
  const rows = await query<BranchRow[]>(
    onlyActive
      ? `SELECT * FROM branches WHERE activa = 1 ORDER BY es_default DESC, nombre ASC`
      : `SELECT * FROM branches ORDER BY es_default DESC, nombre ASC`
  );
  return rows.map(mapBranch);
}

export async function getBranch(id: string): Promise<Branch | null> {
  const rows = await query<BranchRow[]>(
    `SELECT * FROM branches WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? mapBranch(rows[0]) : null;
}

export async function getDefaultBranchId(): Promise<string> {
  const rows = await query<BranchRow[]>(
    `SELECT * FROM branches WHERE es_default = 1 AND activa = 1 LIMIT 1`
  );
  if (rows[0]) return rows[0].id;
  const any = await query<BranchRow[]>(
    `SELECT * FROM branches WHERE activa = 1 ORDER BY nombre ASC LIMIT 1`
  );
  if (!any[0]) throw new HttpError(500, "No hay sucursales configuradas.");
  return any[0].id;
}

export async function upsertBranch(input: {
  id?: string;
  codigo: string;
  nombre: string;
  direccion?: string;
  rubro?: string;
  activa?: boolean;
  esDefault?: boolean;
}): Promise<Branch> {
  const codigo = input.codigo.trim().toLowerCase().replace(/\s+/g, "-");
  const nombre = input.nombre.trim();
  if (!codigo || !nombre) {
    throw new HttpError(400, "Código y nombre son obligatorios.");
  }
  const id = input.id ?? nextId("br");
  const rubro = input.rubro?.trim() ?? "";

  const dup = await query<BranchRow[]>(
    `SELECT id FROM branches WHERE codigo = ? AND id <> ? LIMIT 1`,
    [codigo, id]
  );
  if (dup[0]) {
    throw new HttpError(409, `Ya existe una sucursal con el código "${codigo}".`);
  }

  await withTransaction(async (conn) => {
    if (input.esDefault) {
      await conn.execute(`UPDATE branches SET es_default = 0`);
    }

    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE branches
         SET codigo = ?, nombre = ?, direccion = ?, rubro = ?, activa = ?,
             es_default = COALESCE(?, es_default)
         WHERE id = ?`,
        [
          codigo,
          nombre,
          input.direccion?.trim() ?? "",
          rubro,
          input.activa === false ? 0 : 1,
          input.esDefault === undefined ? null : input.esDefault ? 1 : 0,
          id,
        ]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Sucursal no encontrada.");
      }
    } else {
      await conn.execute(
        `INSERT INTO branches (id, codigo, nombre, direccion, rubro, activa, es_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          codigo,
          nombre,
          input.direccion?.trim() ?? "",
          rubro,
          input.activa === false ? 0 : 1,
          input.esDefault ? 1 : 0,
        ]
      );
    }
  });

  const saved = await getBranch(id);
  if (!saved) throw new HttpError(500, "No se pudo guardar la sucursal.");
  return saved;
}

export async function setDefaultBranch(id: string): Promise<Branch> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<BranchRow[]>(
      `SELECT * FROM branches WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Sucursal no encontrada.");
    if (!found[0].activa) {
      throw new HttpError(
        400,
        "Reactivá la sucursal antes de marcarla como default."
      );
    }
    await conn.execute(`UPDATE branches SET es_default = 0`);
    await conn.execute(
      `UPDATE branches SET es_default = 1, activa = 1 WHERE id = ?`,
      [id]
    );
  });
  const saved = await getBranch(id);
  if (!saved) throw new HttpError(404, "Sucursal no encontrada.");
  return saved;
}

/**
 * Soft-delete: marca la sucursal como inactiva.
 * Si era default, transfiere el flag a otra sucursal activa.
 */
export async function softDeleteBranch(id: string): Promise<Branch> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<BranchRow[]>(
      `SELECT * FROM branches WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Sucursal no encontrada.");
    if (!found[0].activa) {
      throw new HttpError(400, "La sucursal ya está desactivada.");
    }

    const [others] = await conn.execute<BranchRow[]>(
      `SELECT * FROM branches
       WHERE activa = 1 AND id <> ?
       ORDER BY es_default DESC, nombre ASC LIMIT 1`,
      [id]
    );
    if (!others[0]) {
      throw new HttpError(
        400,
        "No se puede desactivar la única sucursal activa. Creá o reactivá otra primero."
      );
    }

    const wasDefault = Boolean(found[0].es_default);

    await conn.execute(
      `UPDATE branches SET activa = 0, es_default = 0 WHERE id = ?`,
      [id]
    );

    if (wasDefault) {
      await conn.execute(
        `UPDATE branches SET es_default = 1 WHERE id = ?`,
        [others[0].id]
      );
    }
  });

  const saved = await getBranch(id);
  if (!saved) throw new HttpError(404, "Sucursal no encontrada.");
  return saved;
}

/** Reactiva una sucursal soft-deleted. */
export async function restoreBranch(id: string): Promise<Branch> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<BranchRow[]>(
      `SELECT * FROM branches WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Sucursal no encontrada.");
    if (found[0].activa) {
      throw new HttpError(400, "La sucursal ya está activa.");
    }
    await conn.execute(`UPDATE branches SET activa = 1 WHERE id = ?`, [id]);
  });
  const saved = await getBranch(id);
  if (!saved) throw new HttpError(404, "Sucursal no encontrada.");
  return saved;
}

export async function getProductStockByBranch(
  productId: string
): Promise<Record<string, number>> {
  const map = await getProductsStockByBranch([productId]);
  return map.get(productId) ?? {};
}

/** Stock por sucursal para muchos productos (1 query). */
export async function getProductsStockByBranch(
  productIds: string[]
): Promise<Map<string, Record<string, number>>> {
  const map = new Map<string, Record<string, number>>();
  if (!productIds.length) return map;
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await query<
    (RowDataPacket & {
      product_id: string;
      branch_id: string;
      stock: number;
    })[]
  >(
    `SELECT product_id, branch_id, stock
     FROM product_branch_stock
     WHERE product_id IN (${placeholders})`,
    productIds
  );
  for (const row of rows) {
    const bag = map.get(row.product_id) ?? {};
    bag[row.branch_id] = row.stock;
    map.set(row.product_id, bag);
  }
  return map;
}

export async function setProductBranchStock(
  productId: string,
  stocks: Record<string, number>
): Promise<void> {
  await withTransaction(async (conn) => {
    for (const [branchId, stock] of Object.entries(stocks)) {
      const qty = Math.max(0, Math.floor(Number(stock) || 0));
      await conn.execute(
        `INSERT INTO product_branch_stock (product_id, branch_id, stock)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE stock = VALUES(stock)`,
        [productId, branchId, qty]
      );
    }
    // Total = suma de todas las sucursales (no solo las actualizadas)
    const [sumRows] = await conn.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(stock), 0) AS t
       FROM product_branch_stock WHERE product_id = ?`,
      [productId]
    );
    const total = Number(sumRows[0]?.t ?? 0);
    await conn.execute(`UPDATE products SET stock = ? WHERE id = ?`, [
      total,
      productId,
    ]);
  });
}

export async function resolveChannelStock(
  productId: string,
  mode: "total" | "default_branch" | "branch",
  branchId: string | null
): Promise<number> {
  if (mode === "total") {
    const rows = await query<(RowDataPacket & { stock: number })[]>(
      `SELECT stock FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );
    return rows[0]?.stock ?? 0;
  }
  const target =
    mode === "default_branch" ? await getDefaultBranchId() : branchId;
  if (!target) return 0;
  const rows = await query<(RowDataPacket & { stock: number })[]>(
    `SELECT stock FROM product_branch_stock
     WHERE product_id = ? AND branch_id = ? LIMIT 1`,
    [productId, target]
  );
  return rows[0]?.stock ?? 0;
}
