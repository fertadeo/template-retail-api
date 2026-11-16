import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { query, getPool } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getDefaultComercioId } from "./comercios.js";

/** Stock belongs to this local only; no branch mirrors or shared groups. */
export async function deductStock(productId: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  const cid = await getDefaultComercioId();
  const [result] = await getPool().execute<ResultSetHeader>(
    "UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ? AND comercio_id = ?", [qty, productId, cid]);
  if (!result.affectedRows) {
    const rows = await query<RowDataPacket[]>("SELECT id FROM products WHERE id = ? AND comercio_id = ? LIMIT 1", [productId, cid]);
    if (!rows.length) throw new HttpError(404, "Producto no encontrado.");
  }
}
