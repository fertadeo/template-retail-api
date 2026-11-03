import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type {
  DiscountBasis,
  DiscountMode,
  DiscountTier,
  Quote,
  QuoteLine,
  QuoteStatus,
} from "../types.js";
import { getDefaultComercioId } from "./comercios.js";
import {
  getDiscountRule,
  normalizeTiers,
  resolveTierPercent,
} from "./discount-rules.js";
import { getClient } from "./clients.js";
import { getProduct } from "./products.js";
import { getDefaultPriceListId, getPriceList } from "./price-lists.js";
import { productPrice } from "../types.js";

type QuoteRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  folio: string;
  client_id: string | null;
  cliente_nombre: string;
  cliente_email: string;
  cliente_telefono: string;
  price_list_id: string | null;
  discount_rule_id: string | null;
  discount_mode: DiscountMode;
  discount_basis: DiscountBasis;
  tiers_json: string | DiscountTier[] | null;
  descuento_manual_pct: string | number;
  status: QuoteStatus;
  validez_dias: number;
  validez_hasta: string | Date | null;
  notas: string;
  subtotal: string | number;
  descuento_monto: string | number;
  descuento_pct_aplicado: string | number;
  total: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type LineRow = RowDataPacket & {
  quote_id: string;
  product_id: string | null;
  sku: string;
  nombre: string;
  cantidad: string | number;
  precio_lista: string | number;
  precio_unitario: string | number;
  line_descuento_pct: string | number;
  importe: string | number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function iso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function parseTiers(raw: QuoteRow["tiers_json"]): DiscountTier[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return normalizeTiers(raw as DiscountTier[]);
  try {
    const parsed = JSON.parse(String(raw)) as DiscountTier[];
    return normalizeTiers(parsed);
  } catch {
    return [];
  }
}

function dateOnly(v: string | Date | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapLine(row: LineRow): QuoteLine {
  return {
    productId: row.product_id,
    sku: row.sku,
    nombre: row.nombre,
    cantidad: num(row.cantidad),
    precioLista: num(row.precio_lista),
    precioUnitario: num(row.precio_unitario),
    lineDescuentoPct: num(row.line_descuento_pct),
    importe: num(row.importe),
  };
}

function mapQuote(row: QuoteRow, lines: QuoteLine[]): Quote {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    folio: row.folio,
    clientId: row.client_id,
    clienteNombre: row.cliente_nombre,
    clienteEmail: row.cliente_email ?? "",
    clienteTelefono: row.cliente_telefono ?? "",
    priceListId: row.price_list_id,
    discountRuleId: row.discount_rule_id,
    discountMode: row.discount_mode,
    discountBasis: row.discount_basis,
    tiers: parseTiers(row.tiers_json),
    descuentoManualPct: num(row.descuento_manual_pct),
    status: row.status,
    validezDias: row.validez_dias,
    validezHasta: dateOnly(row.validez_hasta),
    notas: row.notas ?? "",
    subtotal: num(row.subtotal),
    descuentoMonto: num(row.descuento_monto),
    descuentoPctAplicado: num(row.descuento_pct_aplicado),
    total: num(row.total),
    lines,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function computeQuoteTotals(input: {
  lines: Array<{
    cantidad: number;
    precioUnitario: number;
    lineDescuentoPct?: number;
  }>;
  discountMode: DiscountMode;
  discountBasis: DiscountBasis;
  tiers: DiscountTier[];
  descuentoManualPct: number;
}): {
  lines: Array<{ importe: number; lineDescuentoPct: number }>;
  subtotal: number;
  descuentoPctAplicado: number;
  descuentoMonto: number;
  total: number;
} {
  const lineImporte = input.lines.map((l) => {
    const lineDesc = Math.min(100, Math.max(0, l.lineDescuentoPct ?? 0));
    const bruto = l.cantidad * l.precioUnitario;
    const importe = Math.round(bruto * (1 - lineDesc / 100) * 100) / 100;
    return { importe, lineDescuentoPct: lineDesc };
  });
  const subtotal =
    Math.round(lineImporte.reduce((a, l) => a + l.importe, 0) * 100) / 100;

  let descuentoPctAplicado = 0;
  if (input.discountMode === "manual") {
    descuentoPctAplicado = Math.min(
      100,
      Math.max(0, input.descuentoManualPct || 0)
    );
  } else if (input.discountMode === "rule") {
    const basisValue =
      input.discountBasis === "qty"
        ? input.lines.reduce((a, l) => a + l.cantidad, 0)
        : subtotal;
    descuentoPctAplicado = resolveTierPercent(input.tiers, basisValue)
      .porcentaje;
  }

  const descuentoMonto =
    Math.round(subtotal * (descuentoPctAplicado / 100) * 100) / 100;
  const total = Math.round((subtotal - descuentoMonto) * 100) / 100;
  return {
    lines: lineImporte,
    subtotal,
    descuentoPctAplicado,
    descuentoMonto,
    total,
  };
}

async function loadLines(quoteIds: string[]): Promise<Map<string, QuoteLine[]>> {
  const map = new Map<string, QuoteLine[]>();
  if (!quoteIds.length) return map;
  const ph = quoteIds.map(() => "?").join(",");
  const rows = await query<LineRow[]>(
    `SELECT * FROM quote_lines WHERE quote_id IN (${ph}) ORDER BY id ASC`,
    quoteIds
  );
  for (const row of rows) {
    const bag = map.get(row.quote_id) ?? [];
    bag.push(mapLine(row));
    map.set(row.quote_id, bag);
  }
  return map;
}

async function nextFolio(conn: PoolConnection): Promise<string> {
  await conn.execute(
    `INSERT INTO counters (name, value) VALUES ('folio_presupuesto', 1000)
     ON DUPLICATE KEY UPDATE value = value`
  );
  await conn.execute(
    `UPDATE counters SET value = value + 1 WHERE name = 'folio_presupuesto'`
  );
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT value FROM counters WHERE name = 'folio_presupuesto' LIMIT 1`
  );
  const n = Number(rows[0]?.value ?? 1001);
  return `PRE-${n}`;
}

export async function listQuotes(
  comercioId?: string,
  status?: QuoteStatus
): Promise<Quote[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const rows = status
    ? await query<QuoteRow[]>(
        `SELECT * FROM quotes WHERE comercio_id = ? AND status = ? ORDER BY created_at DESC`,
        [cid, status]
      )
    : await query<QuoteRow[]>(
        `SELECT * FROM quotes WHERE comercio_id = ? ORDER BY created_at DESC`,
        [cid]
      );
  const lines = await loadLines(rows.map((r) => r.id));
  return rows.map((r) => mapQuote(r, lines.get(r.id) ?? []));
}

export async function getQuote(id: string): Promise<Quote | null> {
  const rows = await query<QuoteRow[]>(
    `SELECT * FROM quotes WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  const lines = await loadLines([id]);
  return mapQuote(rows[0], lines.get(id) ?? []);
}

export type QuoteUpsertInput = {
  id?: string;
  comercioId?: string;
  clientId?: string | null;
  clienteNombre?: string;
  clienteEmail?: string;
  clienteTelefono?: string;
  priceListId?: string | null;
  discountRuleId?: string | null;
  discountMode?: DiscountMode;
  discountBasis?: DiscountBasis;
  tiers?: DiscountTier[];
  descuentoManualPct?: number;
  status?: QuoteStatus;
  validezDias?: number;
  notas?: string;
  lines: Array<{
    productId?: string | null;
    sku?: string;
    nombre?: string;
    cantidad: number;
    precioUnitario?: number;
    lineDescuentoPct?: number;
  }>;
};

export async function upsertQuote(input: QuoteUpsertInput): Promise<Quote> {
  if (!input.lines?.length) {
    throw new HttpError(400, "Agregá al menos una línea al presupuesto.");
  }
  const comercioId = input.comercioId || (await getDefaultComercioId());

  let clientId = input.clientId ?? null;
  let clienteNombre = (input.clienteNombre ?? "").trim();
  let clienteEmail = (input.clienteEmail ?? "").trim();
  let clienteTelefono = (input.clienteTelefono ?? "").trim();
  if (clientId) {
    const client = await getClient(clientId);
    if (!client) throw new HttpError(404, "Cliente no encontrado.");
    if (!clienteNombre) clienteNombre = client.nombre;
    if (!clienteEmail) clienteEmail = client.email;
    if (!clienteTelefono) clienteTelefono = client.telefono;
  }
  if (!clienteNombre) clienteNombre = "Cliente eventual";

  const priceListId =
    input.priceListId || (await getDefaultPriceListId(comercioId));
  const list = await getPriceList(priceListId);
  if (!list) throw new HttpError(400, "Lista de precios inválida.");

  let discountMode: DiscountMode = input.discountMode ?? "none";
  let discountBasis: DiscountBasis = input.discountBasis ?? "amount";
  let tiers = normalizeTiers(input.tiers ?? []);
  let discountRuleId = input.discountRuleId ?? null;

  if (discountMode === "rule") {
    if (discountRuleId) {
      const rule = await getDiscountRule(discountRuleId);
      if (!rule) throw new HttpError(400, "Regla de descuento no encontrada.");
      discountBasis = input.discountBasis ?? rule.basis;
      // Si no mandaron tiers editados, usar los de la regla
      if (!input.tiers?.length) tiers = rule.tiers;
      else tiers = normalizeTiers(input.tiers);
    } else if (!tiers.length) {
      throw new HttpError(
        400,
        "Elegí una regla o definí escalones para el descuento."
      );
    }
  }

  const resolvedLines: QuoteLine[] = [];
  for (const line of input.lines) {
    const qty = Number(line.cantidad);
    if (!qty || qty <= 0) {
      throw new HttpError(400, "Cantidad inválida en una línea.");
    }
    let productId = line.productId ?? null;
    let sku = (line.sku ?? "").trim().toUpperCase();
    let nombre = (line.nombre ?? "").trim();
    let precioLista = 0;
    let precioUnitario = Number(line.precioUnitario);

    if (productId) {
      const product = await getProduct(productId);
      if (!product) {
        throw new HttpError(400, `Producto ${productId} no encontrado.`);
      }
      sku = product.sku;
      nombre = product.nombre;
      precioLista = productPrice(product, priceListId);
      if (!Number.isFinite(precioUnitario)) precioUnitario = precioLista;
    } else {
      if (!nombre) throw new HttpError(400, "Nombre de línea obligatorio.");
      if (!Number.isFinite(precioUnitario)) {
        throw new HttpError(400, "Precio unitario obligatorio.");
      }
      precioLista = precioUnitario;
    }

    resolvedLines.push({
      productId,
      sku,
      nombre,
      cantidad: qty,
      precioLista,
      precioUnitario,
      lineDescuentoPct: line.lineDescuentoPct ?? 0,
      importe: 0,
    });
  }

  const totals = computeQuoteTotals({
    lines: resolvedLines,
    discountMode,
    discountBasis,
    tiers,
    descuentoManualPct: input.descuentoManualPct ?? 0,
  });
  for (let i = 0; i < resolvedLines.length; i++) {
    resolvedLines[i].importe = totals.lines[i].importe;
    resolvedLines[i].lineDescuentoPct = totals.lines[i].lineDescuentoPct;
  }

  const validezDias = Math.max(1, input.validezDias ?? 15);
  const validezHasta = new Date();
  validezHasta.setDate(validezHasta.getDate() + validezDias);
  const validezStr = validezHasta.toISOString().slice(0, 10);
  const status: QuoteStatus = input.status ?? "borrador";
  const notas = input.notas?.trim() ?? "";
  const id = input.id ?? nextId("q");

  await withTransaction(async (conn) => {
    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE quotes SET
           client_id = ?, cliente_nombre = ?, cliente_email = ?, cliente_telefono = ?,
           price_list_id = ?, discount_rule_id = ?, discount_mode = ?, discount_basis = ?,
           tiers_json = ?, descuento_manual_pct = ?, status = ?, validez_dias = ?,
           validez_hasta = ?, notas = ?, subtotal = ?, descuento_monto = ?,
           descuento_pct_aplicado = ?, total = ?, comercio_id = ?
         WHERE id = ?`,
        [
          clientId,
          clienteNombre,
          clienteEmail,
          clienteTelefono,
          priceListId,
          discountRuleId,
          discountMode,
          discountBasis,
          JSON.stringify(tiers),
          input.descuentoManualPct ?? 0,
          status,
          validezDias,
          validezStr,
          notas,
          totals.subtotal,
          totals.descuentoMonto,
          totals.descuentoPctAplicado,
          totals.total,
          comercioId,
          id,
        ]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Presupuesto no encontrado.");
      }
      await conn.execute(`DELETE FROM quote_lines WHERE quote_id = ?`, [id]);
    } else {
      const folio = await nextFolio(conn);
      await conn.execute(
        `INSERT INTO quotes (
           id, comercio_id, folio, client_id, cliente_nombre, cliente_email, cliente_telefono,
           price_list_id, discount_rule_id, discount_mode, discount_basis, tiers_json,
           descuento_manual_pct, status, validez_dias, validez_hasta, notas,
           subtotal, descuento_monto, descuento_pct_aplicado, total
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          comercioId,
          folio,
          clientId,
          clienteNombre,
          clienteEmail,
          clienteTelefono,
          priceListId,
          discountRuleId,
          discountMode,
          discountBasis,
          JSON.stringify(tiers),
          input.descuentoManualPct ?? 0,
          status,
          validezDias,
          validezStr,
          notas,
          totals.subtotal,
          totals.descuentoMonto,
          totals.descuentoPctAplicado,
          totals.total,
        ]
      );
    }

    for (const line of resolvedLines) {
      await conn.execute(
        `INSERT INTO quote_lines
         (quote_id, product_id, sku, nombre, cantidad, precio_lista, precio_unitario, line_descuento_pct, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.productId,
          line.sku,
          line.nombre,
          line.cantidad,
          line.precioLista,
          line.precioUnitario,
          line.lineDescuentoPct,
          line.importe,
        ]
      );
    }
  });

  const saved = await getQuote(id);
  if (!saved) throw new HttpError(500, "No se pudo guardar el presupuesto.");
  return saved;
}

export async function updateQuoteStatus(
  id: string,
  status: QuoteStatus
): Promise<Quote> {
  const current = await getQuote(id);
  if (!current) throw new HttpError(404, "Presupuesto no encontrado.");
  await query(`UPDATE quotes SET status = ? WHERE id = ?`, [status, id]);
  return (await getQuote(id))!;
}

export async function deleteQuote(id: string): Promise<void> {
  const { execute } = await import("../db/pool.js");
  const result = await execute(`DELETE FROM quotes WHERE id = ?`, [id]);
  if (result.affectedRows === 0) {
    throw new HttpError(404, "Presupuesto no encontrado.");
  }
}

/** Preview de totales sin persistir (útil para el front al editar). */
export async function previewQuote(input: QuoteUpsertInput): Promise<{
  lines: QuoteLine[];
  subtotal: number;
  descuentoPctAplicado: number;
  descuentoMonto: number;
  total: number;
  tiers: DiscountTier[];
}> {
  // Reusa upsert logic parcialmente vía dry-run: armamos líneas como upsert
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const priceListId =
    input.priceListId || (await getDefaultPriceListId(comercioId));

  let discountMode: DiscountMode = input.discountMode ?? "none";
  let discountBasis: DiscountBasis = input.discountBasis ?? "amount";
  let tiers = normalizeTiers(input.tiers ?? []);
  if (discountMode === "rule" && input.discountRuleId && !input.tiers?.length) {
    const rule = await getDiscountRule(input.discountRuleId);
    if (rule) {
      tiers = rule.tiers;
      discountBasis = input.discountBasis ?? rule.basis;
    }
  }

  const resolvedLines: QuoteLine[] = [];
  for (const line of input.lines) {
    const qty = Number(line.cantidad) || 0;
    let productId = line.productId ?? null;
    let sku = (line.sku ?? "").trim().toUpperCase();
    let nombre = (line.nombre ?? "").trim();
    let precioLista = 0;
    let precioUnitario = Number(line.precioUnitario);
    if (productId) {
      const product = await getProduct(productId);
      if (product) {
        sku = product.sku;
        nombre = product.nombre;
        precioLista = productPrice(product, priceListId);
        if (!Number.isFinite(precioUnitario)) precioUnitario = precioLista;
      }
    }
    if (!Number.isFinite(precioUnitario)) precioUnitario = 0;
    resolvedLines.push({
      productId,
      sku,
      nombre: nombre || sku || "Ítem",
      cantidad: qty,
      precioLista,
      precioUnitario,
      lineDescuentoPct: line.lineDescuentoPct ?? 0,
      importe: 0,
    });
  }

  const totals = computeQuoteTotals({
    lines: resolvedLines,
    discountMode,
    discountBasis,
    tiers,
    descuentoManualPct: input.descuentoManualPct ?? 0,
  });
  for (let i = 0; i < resolvedLines.length; i++) {
    resolvedLines[i].importe = totals.lines[i].importe;
  }
  return {
    lines: resolvedLines,
    subtotal: totals.subtotal,
    descuentoPctAplicado: totals.descuentoPctAplicado,
    descuentoMonto: totals.descuentoMonto,
    total: totals.total,
    tiers,
  };
}
