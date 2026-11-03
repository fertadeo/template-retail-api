import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { execute, query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type {
  Comercio,
  StockShareGroup,
  StockShareMode,
} from "../types.js";

type ComercioRow = RowDataPacket & {
  id: string;
  codigo: string;
  nombre: string;
  rubro: string;
  direccion: string;
  activa: number;
  es_default: number;
};

type GroupRow = RowDataPacket & {
  id: string;
  nombre: string;
  modo: StockShareMode;
  activa: number;
};

function mapComercio(row: ComercioRow): Comercio {
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    rubro: row.rubro ?? "",
    direccion: row.direccion ?? "",
    activa: Boolean(row.activa),
    esDefault: Boolean(row.es_default),
  };
}

export async function listComercios(onlyActive = false): Promise<Comercio[]> {
  const rows = await query<ComercioRow[]>(
    onlyActive
      ? `SELECT * FROM comercios WHERE activa = 1 ORDER BY es_default DESC, nombre ASC`
      : `SELECT * FROM comercios ORDER BY es_default DESC, nombre ASC`
  );
  return rows.map(mapComercio);
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
  if (!any[0]) throw new HttpError(500, "No hay comercios configurados.");
  return any[0].id;
}

export async function resolveComercioId(
  raw: string | null | undefined
): Promise<string> {
  if (raw?.trim()) {
    const c = await getComercio(raw.trim());
    if (!c) throw new HttpError(404, "Comercio no encontrado.");
    if (!c.activa) throw new HttpError(400, "Comercio inactivo.");
    return c.id;
  }
  return getDefaultComercioId();
}

export async function upsertComercio(input: {
  id?: string;
  codigo: string;
  nombre: string;
  rubro?: string;
  direccion?: string;
  activa?: boolean;
  esDefault?: boolean;
}): Promise<Comercio> {
  const codigo = input.codigo.trim().toLowerCase().replace(/\s+/g, "-");
  const nombre = input.nombre.trim();
  if (!codigo || !nombre) {
    throw new HttpError(400, "Código y nombre son obligatorios.");
  }
  const id = input.id ?? nextId("co");

  await withTransaction(async (conn) => {
    if (input.esDefault) {
      await conn.execute(`UPDATE comercios SET es_default = 0`);
    }

    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE comercios
         SET codigo = ?, nombre = ?, rubro = ?, direccion = ?, activa = ?,
             es_default = COALESCE(?, es_default)
         WHERE id = ?`,
        [
          codigo,
          nombre,
          input.rubro?.trim() ?? "",
          input.direccion?.trim() ?? "",
          input.activa === false ? 0 : 1,
          input.esDefault === undefined ? null : input.esDefault ? 1 : 0,
          id,
        ]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Comercio no encontrado.");
      }
    } else {
      await conn.execute(
        `INSERT INTO comercios
         (id, codigo, nombre, rubro, direccion, activa, es_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          codigo,
          nombre,
          input.rubro?.trim() ?? "",
          input.direccion?.trim() ?? "",
          input.activa === false ? 0 : 1,
          input.esDefault ? 1 : 0,
        ]
      );
      // Listas base del nuevo comercio
      await conn.execute(
        `INSERT INTO price_lists (id, comercio_id, nombre, codigo, activa, es_default)
         VALUES (?, ?, 'Minorista', 'minorista', 1, 1),
                (?, ?, 'Mayorista', 'mayorista', 1, 0)`,
        [`pl_${id}_min`, id, `pl_${id}_may`, id]
      );
    }
  });

  const created = await getComercio(id);
  if (!created) throw new HttpError(500, "No se pudo guardar el comercio.");
  return created;
}

export async function setDefaultComercio(id: string): Promise<Comercio> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<ComercioRow[]>(
      `SELECT * FROM comercios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Comercio no encontrado.");
    await conn.execute(`UPDATE comercios SET es_default = 0`);
    await conn.execute(
      `UPDATE comercios SET es_default = 1, activa = 1 WHERE id = ?`,
      [id]
    );
  });
  return (await getComercio(id))!;
}

export async function softDeleteComercio(id: string): Promise<Comercio> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<ComercioRow[]>(
      `SELECT * FROM comercios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Comercio no encontrado.");
    if (!found[0].activa) {
      throw new HttpError(400, "El comercio ya está en la papelera.");
    }

    const [others] = await conn.execute<ComercioRow[]>(
      `SELECT * FROM comercios
       WHERE activa = 1 AND id <> ?
       ORDER BY es_default DESC, nombre ASC LIMIT 1`,
      [id]
    );
    if (!others[0]) {
      throw new HttpError(
        400,
        "No se puede archivar el único comercio activo. Creá o reactivá otro primero."
      );
    }

    const wasDefault = Boolean(found[0].es_default);

    await conn.execute(
      `UPDATE comercios SET activa = 0, es_default = 0 WHERE id = ?`,
      [id]
    );
    // Sacarlo de grupos de stock para no dejar miembros fantasma.
    await conn.execute(
      `DELETE FROM stock_share_members WHERE comercio_id = ?`,
      [id]
    );

    if (wasDefault) {
      await conn.execute(`UPDATE comercios SET es_default = 1 WHERE id = ?`, [
        others[0].id,
      ]);
    }
  });

  const saved = await getComercio(id);
  if (!saved) throw new HttpError(404, "Comercio no encontrado.");
  return saved;
}

export async function restoreComercio(id: string): Promise<Comercio> {
  await withTransaction(async (conn) => {
    const [found] = await conn.execute<ComercioRow[]>(
      `SELECT * FROM comercios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!found[0]) throw new HttpError(404, "Comercio no encontrado.");
    if (found[0].activa) {
      throw new HttpError(400, "El comercio ya está activo.");
    }
    await conn.execute(`UPDATE comercios SET activa = 1 WHERE id = ?`, [id]);
  });
  const saved = await getComercio(id);
  if (!saved) throw new HttpError(404, "Comercio no encontrado.");
  return saved;
}

async function loadGroupMembers(
  groupIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!groupIds.length) return map;
  const ph = groupIds.map(() => "?").join(",");
  const rows = await query<
    (RowDataPacket & { group_id: string; comercio_id: string })[]
  >(
    `SELECT group_id, comercio_id FROM stock_share_members
     WHERE group_id IN (${ph})`,
    groupIds
  );
  for (const row of rows) {
    const bag = map.get(row.group_id) ?? [];
    bag.push(row.comercio_id);
    map.set(row.group_id, bag);
  }
  return map;
}

export async function listStockShareGroups(): Promise<StockShareGroup[]> {
  const rows = await query<GroupRow[]>(
    `SELECT * FROM stock_share_groups ORDER BY nombre ASC`
  );
  const members = await loadGroupMembers(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    modo: r.modo,
    activa: Boolean(r.activa),
    comercioIds: members.get(r.id) ?? [],
  }));
}

export async function upsertStockShareGroup(input: {
  id?: string;
  nombre: string;
  modo: StockShareMode;
  activa?: boolean;
  comercioIds: string[];
}): Promise<StockShareGroup> {
  const nombre = input.nombre.trim();
  if (!nombre) throw new HttpError(400, "Nombre obligatorio.");
  if (!input.comercioIds.length) {
    throw new HttpError(400, "Elegí al menos un comercio.");
  }
  if (input.modo === "shared" || input.modo === "rotate") {
    if (input.comercioIds.length < 2 && input.modo === "shared") {
      throw new HttpError(
        400,
        "Para compartir stock hacen falta al menos 2 comercios."
      );
    }
  }

  // Un comercio no puede estar en dos grupos activos a la vez
  const unique = [...new Set(input.comercioIds)];
  const id = input.id ?? nextId("sg");

  await withTransaction(async (conn) => {
    for (const cid of unique) {
      const [conflict] = await conn.execute<
        (RowDataPacket & { group_id: string })[]
      >(
        `SELECT m.group_id FROM stock_share_members m
         INNER JOIN stock_share_groups g ON g.id = m.group_id
         WHERE m.comercio_id = ? AND g.activa = 1 AND m.group_id <> ?`,
        [cid, id]
      );
      if (conflict[0]) {
        throw new HttpError(
          400,
          `El comercio ${cid} ya pertenece a otro grupo de stock activo.`
        );
      }
    }

    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE stock_share_groups SET nombre = ?, modo = ?, activa = ? WHERE id = ?`,
        [nombre, input.modo, input.activa === false ? 0 : 1, id]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Grupo no encontrado.");
      }
      await conn.execute(
        `DELETE FROM stock_share_members WHERE group_id = ?`,
        [id]
      );
    } else {
      await conn.execute(
        `INSERT INTO stock_share_groups (id, nombre, modo, activa)
         VALUES (?, ?, ?, ?)`,
        [id, nombre, input.modo, input.activa === false ? 0 : 1]
      );
    }

    for (const cid of unique) {
      await conn.execute(
        `INSERT INTO stock_share_members (group_id, comercio_id) VALUES (?, ?)`,
        [id, cid]
      );
    }

    // Si es shared, inicializar shared_stock con el máximo actual por SKU
    if (input.modo === "shared") {
      const ph = unique.map(() => "?").join(",");
      const [skuRows] = await conn.execute<
        (RowDataPacket & { sku: string; stock: number })[]
      >(
        `SELECT UPPER(sku) AS sku, MAX(stock) AS stock
         FROM products
         WHERE comercio_id IN (${ph}) AND activo = 1
         GROUP BY UPPER(sku)`,
        unique
      );
      for (const row of skuRows) {
        await conn.execute(
          `INSERT INTO shared_stock (group_id, sku, stock)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE stock = GREATEST(stock, VALUES(stock))`,
          [id, row.sku, row.stock]
        );
        await conn.execute(
          `UPDATE products SET stock = ?
           WHERE comercio_id IN (${ph}) AND UPPER(sku) = ?`,
          [row.stock, ...unique, row.sku]
        );
      }
    }
  });

  const groups = await listStockShareGroups();
  const found = groups.find((g) => g.id === id);
  if (!found) throw new HttpError(500, "No se pudo guardar el grupo.");
  return found;
}

export async function findShareGroupForComercio(
  comercioId: string
): Promise<StockShareGroup | null> {
  const rows = await query<GroupRow[]>(
    `SELECT g.* FROM stock_share_groups g
     INNER JOIN stock_share_members m ON m.group_id = g.id
     WHERE m.comercio_id = ? AND g.activa = 1
     LIMIT 1`,
    [comercioId]
  );
  if (!rows[0]) return null;
  const members = await loadGroupMembers([rows[0].id]);
  return {
    id: rows[0].id,
    nombre: rows[0].nombre,
    modo: rows[0].modo,
    activa: Boolean(rows[0].activa),
    comercioIds: members.get(rows[0].id) ?? [],
  };
}

/** Stock efectivo de un producto (respeta pool compartido). */
export async function getEffectiveStock(
  productId: string
): Promise<{ stock: number; shared: boolean; groupId: string | null }> {
  const rows = await query<
    (RowDataPacket & { id: string; sku: string; stock: number; comercio_id: string })[]
  >(`SELECT id, sku, stock, comercio_id FROM products WHERE id = ? LIMIT 1`, [
    productId,
  ]);
  const p = rows[0];
  if (!p) throw new HttpError(404, "Producto no encontrado.");
  const group = await findShareGroupForComercio(p.comercio_id);
  if (group?.modo === "shared") {
    const ss = await query<(RowDataPacket & { stock: number })[]>(
      `SELECT stock FROM shared_stock WHERE group_id = ? AND sku = ? LIMIT 1`,
      [group.id, p.sku.toUpperCase()]
    );
    return {
      stock: ss[0]?.stock ?? p.stock,
      shared: true,
      groupId: group.id,
    };
  }
  return { stock: p.stock, shared: false, groupId: group?.id ?? null };
}

/** Descuenta stock (venta). En modo shared sincroniza todos los comercios del grupo. */
export async function deductStock(
  productId: string,
  qty: number
): Promise<void> {
  if (qty <= 0) return;
  const rows = await query<
    (RowDataPacket & { id: string; sku: string; stock: number; comercio_id: string })[]
  >(`SELECT id, sku, stock, comercio_id FROM products WHERE id = ? LIMIT 1`, [
    productId,
  ]);
  const p = rows[0];
  if (!p) throw new HttpError(404, "Producto no encontrado.");
  const group = await findShareGroupForComercio(p.comercio_id);

  await withTransaction(async (conn) => {
    if (group?.modo === "shared") {
      const sku = p.sku.toUpperCase();
      await conn.execute(
        `INSERT INTO shared_stock (group_id, sku, stock)
         VALUES (?, ?, GREATEST(0, ?))
         ON DUPLICATE KEY UPDATE stock = GREATEST(0, stock - ?)`,
        [group.id, sku, Math.max(0, p.stock - qty), qty]
      );
      const [ss] = await conn.execute<(RowDataPacket & { stock: number })[]>(
        `SELECT stock FROM shared_stock WHERE group_id = ? AND sku = ? LIMIT 1`,
        [group.id, sku]
      );
      const next = ss[0]?.stock ?? 0;
      const ph = group.comercioIds.map(() => "?").join(",");
      await conn.execute(
        `UPDATE products SET stock = ?
         WHERE comercio_id IN (${ph}) AND UPPER(sku) = ?`,
        [next, ...group.comercioIds, sku]
      );
    } else {
      await conn.execute(
        `UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?`,
        [qty, productId]
      );
      // mirror branch stock default if present
      await conn.execute(
        `UPDATE product_branch_stock pbs
         INNER JOIN branches b ON b.id = pbs.branch_id AND b.es_default = 1
         SET pbs.stock = GREATEST(0, pbs.stock - ?)
         WHERE pbs.product_id = ?`,
        [qty, productId]
      );
    }
  });
}

/** Setea stock de un producto; si el comercio está en grupo shared, actualiza el pool. */
export async function setProductStock(
  productId: string,
  stock: number
): Promise<void> {
  const qty = Math.max(0, Math.floor(stock));
  const rows = await query<
    (RowDataPacket & { sku: string; comercio_id: string })[]
  >(`SELECT sku, comercio_id FROM products WHERE id = ? LIMIT 1`, [productId]);
  const p = rows[0];
  if (!p) throw new HttpError(404, "Producto no encontrado.");
  const group = await findShareGroupForComercio(p.comercio_id);

  await withTransaction(async (conn) => {
    if (group?.modo === "shared") {
      const sku = p.sku.toUpperCase();
      await conn.execute(
        `INSERT INTO shared_stock (group_id, sku, stock) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE stock = VALUES(stock)`,
        [group.id, sku, qty]
      );
      const ph = group.comercioIds.map(() => "?").join(",");
      await conn.execute(
        `UPDATE products SET stock = ?
         WHERE comercio_id IN (${ph}) AND UPPER(sku) = ?`,
        [qty, ...group.comercioIds, sku]
      );
    } else {
      await conn.execute(`UPDATE products SET stock = ? WHERE id = ?`, [
        qty,
        productId,
      ]);
    }
  });
}

/** Transfiere stock entre comercios del mismo grupo (modo rotate o shared). */
export async function transferStock(input: {
  fromComercioId: string;
  toComercioId: string;
  sku: string;
  quantity: number;
}): Promise<{ fromStock: number; toStock: number }> {
  const qty = Math.floor(input.quantity);
  if (qty <= 0) throw new HttpError(400, "Cantidad inválida.");
  if (input.fromComercioId === input.toComercioId) {
    throw new HttpError(400, "Origen y destino deben ser distintos.");
  }

  const group = await findShareGroupForComercio(input.fromComercioId);
  if (!group) {
    throw new HttpError(
      400,
      "El comercio origen no pertenece a un grupo de stock."
    );
  }
  if (!group.comercioIds.includes(input.toComercioId)) {
    throw new HttpError(
      400,
      "Los comercios no comparten el mismo grupo de stock. No se puede rotar."
    );
  }

  const sku = input.sku.trim().toUpperCase();

  return withTransaction(async (conn) => {
    if (group.modo === "shared") {
      // En shared el stock ya es común: no hay transferencia física, solo OK
      const [ss] = await conn.execute<(RowDataPacket & { stock: number })[]>(
        `SELECT stock FROM shared_stock WHERE group_id = ? AND sku = ? LIMIT 1`,
        [group.id, sku]
      );
      const stock = ss[0]?.stock ?? 0;
      return { fromStock: stock, toStock: stock };
    }

    const [fromRows] = await conn.execute<
      (RowDataPacket & { id: string; stock: number })[]
    >(
      `SELECT id, stock FROM products
       WHERE comercio_id = ? AND UPPER(sku) = ? LIMIT 1`,
      [input.fromComercioId, sku]
    );
    const from = fromRows[0];
    if (!from) throw new HttpError(404, "Producto no encontrado en origen.");
    if (from.stock < qty) {
      throw new HttpError(400, `Stock insuficiente en origen (${from.stock}).`);
    }

    const [toRows] = await conn.execute<
      (RowDataPacket & { id: string; stock: number })[]
    >(
      `SELECT id, stock FROM products
       WHERE comercio_id = ? AND UPPER(sku) = ? LIMIT 1`,
      [input.toComercioId, sku]
    );
    const to = toRows[0];
    if (!to) {
      throw new HttpError(
        404,
        "No hay producto con ese SKU en el comercio destino. Creá el SKU allí primero."
      );
    }

    await conn.execute(
      `UPDATE products SET stock = stock - ? WHERE id = ?`,
      [qty, from.id]
    );
    await conn.execute(
      `UPDATE products SET stock = stock + ? WHERE id = ?`,
      [qty, to.id]
    );

    return {
      fromStock: from.stock - qty,
      toStock: to.stock + qty,
    };
  });
}

export async function deleteStockShareGroup(id: string): Promise<void> {
  const result = await execute(
    `DELETE FROM stock_share_groups WHERE id = ?`,
    [id]
  );
  if (result.affectedRows === 0) {
    throw new HttpError(404, "Grupo no encontrado.");
  }
}
