import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getCatalogSettings } from "./catalog.js";
const configuredOffset = Number(process.env.RETAIL_UTC_OFFSET_MINUTES ?? -180);
export const businessOffset =
  Number.isInteger(configuredOffset) && Math.abs(configuredOffset) <= 840
    ? configuredOffset
    : -180;
export const businessDay = (now = Date.now()) =>
  new Date(now + businessOffset * 60000).toISOString().slice(0, 10);
export const cents = (value: number) => Math.round(value * 100);
export function cashBalance(opening: number, sales: number, counted: number) {
  const expected = (cents(opening) + cents(sales)) / 100;
  return { expected, difference: (cents(counted) - cents(expected)) / 100 };
}
export function dateWindow(from: string, to: string) {
  const a = Date.parse(`${from}T00:00:00Z`),
    b = Date.parse(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    new Date(a).toISOString().slice(0, 10) !== from ||
    new Date(b).toISOString().slice(0, 10) !== to ||
    b < a ||
    b - a > 365 * 86400000
  )
    throw new HttpError(400, "Elegí un rango válido de hasta 366 días.");
  const sql = (time: number) =>
    new Date(time - businessOffset * 60000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  return { start: sql(a), end: sql(b + 86400000) };
}
type CashRow = RowDataPacket & {
  id: string;
  comercio_id: string;
  opened_by: string;
  closed_by: string | null;
  opening_amount: string | number;
  currency: string;
  opened_iso: string;
  closed_iso: string | null;
  counted_amount: string | number | null;
  cash_sales: string | number | null;
  transfer_sales: string | number | null;
  expected_amount: string | number | null;
  difference: string | number | null;
  ticket_count: number | null;
  note: string;
  version: number;
  opener_name: string | null;
  closer_name: string | null;
};
const FIELDS = `c.*, DATE_FORMAT(c.opened_at,'%Y-%m-%dT%H:%i:%s.000Z') AS opened_iso, DATE_FORMAT(c.closed_at,'%Y-%m-%dT%H:%i:%s.000Z') AS closed_iso, u.nombre AS opener_name, closer.nombre AS closer_name`;
const CASH_FROM = `FROM cash_sessions c LEFT JOIN users u ON u.id = c.opened_by LEFT JOIN users closer ON closer.id = c.closed_by`;
const AMOUNT = `COALESCE((SELECT SUM(ol.cantidad * ol.precio_unitario) FROM order_lines ol WHERE ol.order_id = o.id),0) + CASE WHEN o.con_envio = 1 THEN o.envio_costo ELSE 0 END`;
const SUMMARY = `SELECT COUNT(*) AS tickets, COALESCE(SUM(amount),0) AS total, COALESCE(SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END),0) AS cash, COALESCE(SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END),0) AS transfer FROM (SELECT ${AMOUNT} AS amount, o.metodo_pago AS method FROM orders o WHERE o.comercio_id = ? AND o.cash_session_id = ? AND o.canal = 'pos' AND o.status NOT IN ('cancelado','borrador')) sales`;
function map(
  row: CashRow,
  live?: { tickets: number; cash: number; transfer: number; total: number },
) {
  const cash = live ? Number(live.cash) : Number(row.cash_sales ?? 0);
  const transfer = live
    ? Number(live.transfer)
    : Number(row.transfer_sales ?? 0);
  const expected = live
    ? cashBalance(Number(row.opening_amount), cash, 0).expected
    : Number(row.expected_amount);
  return {
    id: row.id,
    openedBy: row.opened_by,
    openedByName: row.opener_name ?? "Usuario",
    closedBy: row.closed_by,
    closedByName: row.closer_name,
    openingAmount: Number(row.opening_amount),
    currency: row.currency,
    openedAt: row.opened_iso,
    closedAt: row.closed_iso,
    countedAmount:
      row.counted_amount === null ? null : Number(row.counted_amount),
    cashSales: cash,
    transferSales: transfer,
    expectedAmount: expected,
    difference: row.difference === null ? null : Number(row.difference),
    tickets: live ? Number(live.tickets) : Number(row.ticket_count ?? 0),
    note: row.note,
    version: Number(row.version),
  };
}
export async function currentCash(cid: string) {
  const rows = await query<CashRow[]>(
    `SELECT ${FIELDS} ${CASH_FROM} WHERE c.open_comercio_id = ? LIMIT 1`,
    [cid],
  );
  if (!rows[0])
    return {
      session: null,
      today: businessDay(),
      utcOffsetMinutes: businessOffset,
    };
  const totals = await query<
    (RowDataPacket & {
      tickets: number;
      total: number;
      cash: number;
      transfer: number;
    })[]
  >(SUMMARY, [cid, rows[0].id]);
  return {
    session: map(rows[0], totals[0]),
    today: businessDay(),
    utcOffsetMinutes: businessOffset,
  };
}
export async function requireOpenCash(conn: PoolConnection, cid: string) {
  const [rows] = await conn.execute<RowDataPacket[]>(
    "SELECT id FROM cash_sessions WHERE open_comercio_id = ? FOR UPDATE",
    [cid],
  );
  if (!rows[0])
    throw new HttpError(
      409,
      "La caja está cerrada. Abrila antes de cobrar la venta.",
    );
  await conn.execute(
    "UPDATE cash_sessions SET version = version + 1 WHERE id = ?",
    [rows[0].id],
  );
  return String(rows[0].id);
}
export async function openCash(cid: string, userId: string, opening: number) {
  const currency = (await getCatalogSettings(cid)).currency;
  await withTransaction(async (conn) => {
    await conn.execute("SELECT id FROM comercios WHERE id = ? FOR UPDATE", [
      cid,
    ]);
    const [existing] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM cash_sessions WHERE open_comercio_id = ? FOR UPDATE",
      [cid],
    );
    if (existing.length)
      throw new HttpError(
        409,
        "Ya hay una caja abierta para este comercio. Actualizá el estado para verla.",
      );
    await conn.execute(
      "INSERT INTO cash_sessions (id, comercio_id, open_comercio_id, opened_by, opening_amount, currency, opened_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), cid, cid, userId, cents(opening) / 100, currency],
    );
  });
  return currentCash(cid);
}
export async function closeCash(
  cid: string,
  user: { id: string; role: string },
  id: string,
  input: { counted: number; version: number; note: string },
) {
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute<CashRow[]>(
      "SELECT * FROM cash_sessions WHERE id = ? AND comercio_id = ? FOR UPDATE",
      [id, cid],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Caja no encontrada.");
    if (row.closed_at) throw new HttpError(409, "Esta caja ya está cerrada.");
    if (
      row.opened_by !== user.id &&
      !["superadmin", "administrador"].includes(user.role)
    )
      throw new HttpError(
        403,
        "Solo quien abrió la caja o un administrador puede cerrarla.",
      );
    if (Number(row.version) !== input.version)
      throw new HttpError(
        409,
        "Se registraron nuevas ventas. Actualizá el resumen y revisá el efectivo contado antes de cerrar.",
      );
    const [totals] = await conn.execute<
      (RowDataPacket & {
        tickets: number;
        total: number;
        cash: number;
        transfer: number;
      })[]
    >(SUMMARY, [cid, id]);
    const result = cashBalance(
      Number(row.opening_amount),
      Number(totals[0].cash),
      input.counted,
    );
    await conn.execute(
      `UPDATE cash_sessions SET open_comercio_id = NULL, closed_by = ?, closed_at = UTC_TIMESTAMP(3), counted_amount = ?, cash_sales = ?, transfer_sales = ?, expected_amount = ?, difference = ?, ticket_count = ?, note = ?, version = version + 1 WHERE id = ? AND comercio_id = ?`,
      [
        user.id,
        cents(input.counted) / 100,
        totals[0].cash,
        totals[0].transfer,
        result.expected,
        result.difference,
        totals[0].tickets,
        input.note,
        id,
        cid,
      ],
    );
  });
  const rows = await query<CashRow[]>(
    `SELECT ${FIELDS} ${CASH_FROM} WHERE c.id = ? AND c.comercio_id = ?`,
    [id, cid],
  );
  return map(rows[0]);
}
export async function cashHistory(cid: string, page: number) {
  const rows = await query<CashRow[]>(
    `SELECT ${FIELDS} ${CASH_FROM} WHERE c.comercio_id = ? AND c.closed_at IS NOT NULL ORDER BY c.opened_at DESC, c.id DESC LIMIT 11 OFFSET ${(page - 1) * 10}`,
    [cid],
  );
  return {
    items: rows.slice(0, 10).map((row) => map(row)),
    page,
    hasMore: rows.length > 10,
  };
}
export async function dailySales(cid: string, from: string, to: string) {
  const window = dateWindow(from, to);
  const currency = (await getCatalogSettings(cid)).currency;
  const rows = await query<
    (RowDataPacket & {
      day: string;
      currency_code: string;
      tickets: number;
      total: number;
      cash: number;
      transfer: number;
      unclassified: number;
    })[]
  >(
    `SELECT DATE_FORMAT(DATE_ADD(s.created_at, INTERVAL ${businessOffset} MINUTE),'%Y-%m-%d') AS day, s.currency_code, COUNT(*) AS tickets,
 SUM(s.amount) AS total, SUM(CASE WHEN s.method = 'efectivo' THEN s.amount ELSE 0 END) AS cash, SUM(CASE WHEN s.method = 'transferencia' THEN s.amount ELSE 0 END) AS transfer, SUM(CASE WHEN s.method IS NULL THEN s.amount ELSE 0 END) AS unclassified
 FROM (SELECT o.created_at, o.metodo_pago AS method, COALESCE(c.currency, ?) AS currency_code, ${AMOUNT} AS amount FROM orders o LEFT JOIN cash_sessions c ON c.id = o.cash_session_id
 WHERE o.comercio_id = ? AND o.canal = 'pos' AND o.status NOT IN ('cancelado','borrador') AND o.created_at >= ? AND o.created_at < ?) s GROUP BY day, s.currency_code ORDER BY day DESC, s.currency_code`,
    [currency, cid, window.start, window.end],
  );
  return {
    from,
    to,
    today: businessDay(),
    utcOffsetMinutes: businessOffset,
    rows: rows.map((row) => ({
      day: row.day,
      currency: row.currency_code,
      tickets: Number(row.tickets),
      total: Number(row.total),
      cash: Number(row.cash),
      transfer: Number(row.transfer),
      unclassified: Number(row.unclassified),
    })),
  };
}
