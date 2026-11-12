import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getComercio } from "./comercios.js";
import { getDefaultPriceListId } from "./price-lists.js";

/* —— Tipos (contrato espejo de Fenec Admin) —— */

export type CatalogOrderStatus =
  | "pendiente"
  | "confirmado"
  | "cobrado"
  | "cancelado"
  | "vencido";

export const CATALOG_ORDER_STATUSES: CatalogOrderStatus[] = [
  "pendiente",
  "confirmado",
  "cobrado",
  "cancelado",
  "vencido",
];

export function isCatalogOrderStatus(v: unknown): v is CatalogOrderStatus {
  return (
    typeof v === "string" &&
    CATALOG_ORDER_STATUSES.includes(v as CatalogOrderStatus)
  );
}

export type CatalogOrderItem = {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  lineTotal: number;
};

export type CatalogOrder = {
  id: string;
  comercioId: string;
  status: CatalogOrderStatus;
  expiresAt: string;
  buyerName: string;
  buyerPhone: string;
  buyerNote: string;
  items: CatalogOrderItem[];
  currency: string;
  total: number;
  whatsappSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogSettings = {
  whatsappPhone: string;
  orderTtlHours: number;
  publicEnabled: boolean;
};

export type CatalogPublicProduct = {
  id: string;
  name: string;
  sku: string;
  category: string;
  description: string;
  unitPrice: number;
  currency: string;
  /** URL de portada (remota, /catalogo-img/… o endpoint público de media). */
  imageDataUrl: string | null;
  images: Array<{
    filename: string;
    mime: string;
    dataUrl: string | null;
  }>;
};

export type CatalogPublicPayload = {
  enabled: boolean;
  branding: { name: string; tagline: string };
  settings: { orderTtlHours: number; whatsappConfigured: boolean };
  products: CatalogPublicProduct[];
};

/* —— Settings (retail_settings por comercio) —— */

const KEY_PHONE = "catalog_whatsapp_phone";
const KEY_TTL = "catalog_order_ttl_hours";
const KEY_ENABLED = "catalog_public_enabled";
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_CURRENCY = "ARS";

let schemaReady = false;

export async function ensureCatalogSchema(): Promise<void> {
  if (schemaReady) return;
  await execute(`
    CREATE TABLE IF NOT EXISTS retail_settings (
      comercio_id VARCHAR(36) NOT NULL,
      setting_key VARCHAR(80) NOT NULL,
      value_text TEXT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (comercio_id, setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS catalog_orders (
      id VARCHAR(40) NOT NULL,
      comercio_id VARCHAR(36) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      expires_at DATETIME NOT NULL,
      buyer_name VARCHAR(190) NOT NULL DEFAULT '',
      buyer_phone VARCHAR(40) NOT NULL DEFAULT '',
      buyer_note TEXT NOT NULL,
      items_json LONGTEXT NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'ARS',
      total DECIMAL(12, 2) NOT NULL DEFAULT 0,
      whatsapp_sent_at DATETIME NULL DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_catalog_orders_comercio (comercio_id, created_at),
      KEY idx_catalog_orders_status (status),
      KEY idx_catalog_orders_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  schemaReady = true;
}

function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function readSettingRows(
  comercioId: string
): Promise<Map<string, string>> {
  await ensureCatalogSchema();
  const rows = await query<
    (RowDataPacket & { setting_key: string; value_text: string | null })[]
  >(
    `SELECT setting_key, value_text FROM retail_settings
     WHERE comercio_id = ? AND setting_key IN (?, ?, ?)`,
    [comercioId, KEY_PHONE, KEY_TTL, KEY_ENABLED]
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.setting_key, r.value_text ?? "");
  return map;
}

async function writeSetting(
  comercioId: string,
  key: string,
  value: string
): Promise<void> {
  await ensureCatalogSchema();
  await execute(
    `INSERT INTO retail_settings (comercio_id, setting_key, value_text, updated_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = UTC_TIMESTAMP()`,
    [comercioId, key, value]
  );
}

export async function getCatalogSettings(
  comercioId: string
): Promise<CatalogSettings> {
  const map = await readSettingRows(comercioId);
  const ttl = Number(map.get(KEY_TTL));
  const enabledRaw = (map.get(KEY_ENABLED) ?? "").trim().toLowerCase();
  return {
    whatsappPhone: (map.get(KEY_PHONE) ?? "").trim(),
    orderTtlHours:
      Number.isFinite(ttl) && ttl > 0
        ? Math.min(Math.round(ttl), 168)
        : DEFAULT_TTL_HOURS,
    publicEnabled: enabledRaw === "1" || enabledRaw === "true",
  };
}

export async function saveCatalogSettings(
  comercioId: string,
  input: {
    whatsappPhone?: string;
    orderTtlHours?: number | string;
    publicEnabled?: boolean;
  }
): Promise<CatalogSettings> {
  if (input.whatsappPhone !== undefined) {
    const phone = input.whatsappPhone.trim();
    if (phone && digitsOnly(phone).length < 8) {
      throw new HttpError(400, "El WhatsApp del vendedor parece inválido.");
    }
    await writeSetting(comercioId, KEY_PHONE, phone);
  }
  if (input.orderTtlHours !== undefined) {
    const n = Number(input.orderTtlHours);
    if (!Number.isFinite(n) || n < 1 || n > 168) {
      throw new HttpError(400, "La caducidad debe ser entre 1 y 168 horas.");
    }
    await writeSetting(comercioId, KEY_TTL, String(Math.round(n)));
  }
  if (input.publicEnabled !== undefined) {
    await writeSetting(comercioId, KEY_ENABLED, input.publicEnabled ? "1" : "0");
  }
  return getCatalogSettings(comercioId);
}

/* —— Productos públicos —— */

type PubProdRow = RowDataPacket & {
  id: string;
  sku: string;
  nombre: string;
  categoria: string;
  descripcion: string | null;
  precio_default: string | number;
};

type PubImgRow = RowDataPacket & {
  id: string;
  product_id: string;
  filename: string;
  mime: string;
  source_url: string | null;
  has_data: number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

async function loadPublicImages(
  productIds: string[]
): Promise<Map<string, Array<{ filename: string; mime: string; url: string }>>> {
  const map = new Map<
    string,
    Array<{ filename: string; mime: string; url: string }>
  >();
  if (!productIds.length) return map;
  // No se trae data_url: solo si existe, y se sirve por /catalog/public/media/:id
  const rows = await query<PubImgRow[]>(
    `SELECT m.id, m.product_id, m.filename, m.mime, m.source_url,
            (m.data_url IS NOT NULL AND m.data_url <> '') AS has_data
     FROM media_assets m
     WHERE m.product_id IN (${placeholders(productIds.length)})
       AND m.kind = 'image'
     ORDER BY m.is_primary DESC, m.sort_order ASC, m.uploaded_at ASC, m.id ASC`,
    productIds
  );
  for (const r of rows) {
    const src = r.source_url?.trim();
    const url = src
      ? src
      : r.has_data
        ? `/api/catalog/public/media/${encodeURIComponent(r.id)}`
        : null;
    if (!url) continue;
    const bag = map.get(r.product_id) ?? [];
    bag.push({ filename: r.filename, mime: r.mime || "image/jpeg", url });
    map.set(r.product_id, bag);
  }
  return map;
}

async function loadDefaultPrices(
  comercioId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!productIds.length) return map;
  let listId: string;
  try {
    listId = await getDefaultPriceListId(comercioId);
  } catch {
    return map;
  }
  const rows = await query<
    (RowDataPacket & { product_id: string; precio: string | number })[]
  >(
    `SELECT product_id, precio FROM product_prices
     WHERE price_list_id = ? AND product_id IN (${placeholders(productIds.length)})`,
    [listId, ...productIds]
  );
  for (const r of rows) map.set(r.product_id, num(r.precio));
  return map;
}

async function loadPublicProducts(
  comercioId: string,
  onlyId?: string
): Promise<CatalogPublicProduct[]> {
  const rows = await query<PubProdRow[]>(
    onlyId
      ? `SELECT id, sku, nombre, categoria, descripcion, precio_default
         FROM products WHERE comercio_id = ? AND activo = 1 AND id = ? LIMIT 1`
      : `SELECT id, sku, nombre, categoria, descripcion, precio_default
         FROM products WHERE comercio_id = ? AND activo = 1 ORDER BY nombre ASC`,
    onlyId ? [comercioId, onlyId] : [comercioId]
  );
  const ids = rows.map((r) => r.id);
  const [prices, images] = await Promise.all([
    loadDefaultPrices(comercioId, ids),
    loadPublicImages(ids),
  ]);
  return rows.map((r) => {
    const imgs = images.get(r.id) ?? [];
    return {
      id: r.id,
      name: r.nombre,
      sku: r.sku,
      category: r.categoria,
      description: r.descripcion ?? "",
      unitPrice: prices.get(r.id) ?? num(r.precio_default),
      currency: DEFAULT_CURRENCY,
      imageDataUrl: imgs[0]?.url ?? null,
      images: imgs.map((i) => ({
        filename: i.filename,
        mime: i.mime,
        dataUrl: i.url,
      })),
    };
  });
}

async function brandingFor(comercioId: string): Promise<{
  name: string;
  tagline: string;
}> {
  const c = await getComercio(comercioId);
  return {
    name: c?.nombre?.trim() || "Tienda",
    tagline: c?.rubro?.trim() || "Catálogo online",
  };
}

export async function getPublicCatalog(
  comercioId: string
): Promise<CatalogPublicPayload> {
  const settings = await getCatalogSettings(comercioId);
  const [branding, products] = await Promise.all([
    brandingFor(comercioId),
    settings.publicEnabled
      ? loadPublicProducts(comercioId)
      : Promise.resolve([] as CatalogPublicProduct[]),
  ]);
  return {
    enabled: settings.publicEnabled,
    branding,
    settings: {
      orderTtlHours: settings.orderTtlHours,
      whatsappConfigured: digitsOnly(settings.whatsappPhone).length >= 8,
    },
    products,
  };
}

export async function getPublicCatalogProduct(
  comercioId: string,
  id: string
): Promise<CatalogPublicProduct | null> {
  const settings = await getCatalogSettings(comercioId);
  if (!settings.publicEnabled) return null;
  const [product] = await loadPublicProducts(comercioId, id);
  return product ?? null;
}

/** Imagen binaria de un media con data URL (para no inflar el JSON). */
export async function getPublicMediaBinary(
  id: string
): Promise<{ mime: string; body: Buffer } | { redirect: string } | null> {
  const rows = await query<
    (RowDataPacket & {
      mime: string;
      data_url: string | null;
      source_url: string | null;
      comercio_id: string | null;
      p_comercio_id: string | null;
      activo: number | null;
    })[]
  >(
    `SELECT m.mime, m.data_url, m.source_url, m.comercio_id,
            p.comercio_id AS p_comercio_id, p.activo
     FROM media_assets m
     LEFT JOIN products p ON p.id = m.product_id
     WHERE m.id = ? AND m.kind = 'image' LIMIT 1`,
    [id]
  );
  const row = rows[0];
  if (!row || !row.p_comercio_id || !row.activo) return null;
  const settings = await getCatalogSettings(row.p_comercio_id);
  if (!settings.publicEnabled) return null;

  const dataUrl = row.data_url?.trim();
  if (dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (m) {
      const mime = m[1] || row.mime || "image/jpeg";
      const body = m[2]
        ? Buffer.from(m[3], "base64")
        : Buffer.from(decodeURIComponent(m[3]), "utf8");
      return { mime, body };
    }
  }
  const src = row.source_url?.trim();
  if (src) return { redirect: src };
  return null;
}

/* —— Pedidos —— */

type OrderRow = RowDataPacket & {
  id: string;
  comercio_id: string;
  status: string;
  expires_at_s: string;
  buyer_name: string;
  buyer_phone: string;
  buyer_note: string;
  items_json: string;
  currency: string;
  total: string | number;
  whatsapp_sent_at_s: string | null;
  created_at_s: string;
  updated_at_s: string;
};

const ORDER_COLS = `id, comercio_id, status, buyer_name, buyer_phone, buyer_note,
  items_json, currency, total,
  DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.000Z') AS expires_at_s,
  DATE_FORMAT(whatsapp_sent_at, '%Y-%m-%dT%H:%i:%s.000Z') AS whatsapp_sent_at_s,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_at_s,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.000Z') AS updated_at_s`;

function parseItems(raw: string): CatalogOrderItem[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((it: Record<string, unknown>) => ({
      productId: String(it.productId ?? ""),
      name: String(it.name ?? ""),
      quantity: Number(it.quantity) || 0,
      unitPrice: Number(it.unitPrice) || 0,
      currency: String(it.currency ?? DEFAULT_CURRENCY),
      lineTotal: Number(it.lineTotal) || 0,
    }));
  } catch {
    return [];
  }
}

function mapOrder(row: OrderRow): CatalogOrder {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    status: row.status as CatalogOrderStatus,
    expiresAt: row.expires_at_s,
    buyerName: row.buyer_name || "",
    buyerPhone: row.buyer_phone || "",
    buyerNote: row.buyer_note || "",
    items: parseItems(row.items_json),
    currency: row.currency || DEFAULT_CURRENCY,
    total: num(row.total) || 0,
    whatsappSentAt: row.whatsapp_sent_at_s,
    createdAt: row.created_at_s,
    updatedAt: row.updated_at_s,
  };
}

function toMysqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function nextCatalogOrderId(): string {
  return `cord_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** pendiente → vencido cuando expires_at < ahora (UTC). */
export async function expireStaleCatalogOrders(
  comercioId?: string
): Promise<number> {
  await ensureCatalogSchema();
  const result = comercioId
    ? await execute(
        `UPDATE catalog_orders
         SET status = 'vencido', updated_at = UTC_TIMESTAMP()
         WHERE comercio_id = ? AND status = 'pendiente' AND expires_at < UTC_TIMESTAMP()`,
        [comercioId]
      )
    : await execute(
        `UPDATE catalog_orders
         SET status = 'vencido', updated_at = UTC_TIMESTAMP()
         WHERE status = 'pendiente' AND expires_at < UTC_TIMESTAMP()`
      );
  return Number(result.affectedRows || 0);
}

export async function listCatalogOrders(
  comercioId: string
): Promise<CatalogOrder[]> {
  await expireStaleCatalogOrders(comercioId);
  const rows = await query<OrderRow[]>(
    `SELECT ${ORDER_COLS} FROM catalog_orders
     WHERE comercio_id = ? ORDER BY created_at DESC LIMIT 200`,
    [comercioId]
  );
  return rows.map(mapOrder);
}

async function getCatalogOrder(
  comercioId: string,
  id: string
): Promise<CatalogOrder | null> {
  await expireStaleCatalogOrders(comercioId);
  const rows = await query<OrderRow[]>(
    `SELECT ${ORDER_COLS} FROM catalog_orders
     WHERE id = ? AND comercio_id = ? LIMIT 1`,
    [id, comercioId]
  );
  return rows[0] ? mapOrder(rows[0]) : null;
}

export async function updateCatalogOrderStatus(
  comercioId: string,
  id: string,
  status: unknown
): Promise<CatalogOrder> {
  if (!isCatalogOrderStatus(status)) {
    throw new HttpError(400, "Estado de pedido inválido.");
  }
  if (status === "vencido") {
    throw new HttpError(400, "El estado vencido se asigna automáticamente.");
  }
  const existing = await getCatalogOrder(comercioId, id);
  if (!existing) throw new HttpError(404, "Pedido no encontrado.");
  await execute(
    `UPDATE catalog_orders SET status = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND comercio_id = ?`,
    [status, id, comercioId]
  );
  const updated = await getCatalogOrder(comercioId, id);
  if (!updated) throw new HttpError(500, "No se pudo actualizar el pedido.");
  return updated;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: currency || DEFAULT_CURRENCY,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function buildWhatsAppOrderUrl(
  phone: string,
  order: CatalogOrder
): string {
  const digits = digitsOnly(phone);
  const lines = [
    `Pedido catálogo ${order.id}`,
    `Estado: ${order.status}`,
    `Vence: ${new Date(order.expiresAt).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
    })}`,
    "",
    ...order.items.map(
      (it) =>
        `• ${it.quantity} × ${it.name} — ${formatMoney(it.lineTotal, it.currency)}`
    ),
    "",
    `Total: ${formatMoney(order.total, order.currency)}`,
    `Comprador: ${order.buyerName}`,
    `Tel: ${order.buyerPhone}`,
  ];
  if (order.buyerNote.trim()) {
    lines.push(`Nota: ${order.buyerNote.trim()}`);
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join("\n"))}`;
}

export type CreateCatalogOrderInput = {
  buyerName?: string;
  buyerPhone?: string;
  buyerNote?: string;
  items?: Array<{ productId?: string; quantity?: number }>;
};

export async function createPublicCatalogOrder(
  comercioId: string,
  input: CreateCatalogOrderInput
): Promise<{ order: CatalogOrder; waUrl: string }> {
  const settings = await getCatalogSettings(comercioId);
  if (!settings.publicEnabled) {
    throw new HttpError(400, "La tienda pública está desactivada.");
  }
  const phone = settings.whatsappPhone.trim();
  if (digitsOnly(phone).length < 8) {
    throw new HttpError(400, "Falta configurar el WhatsApp del vendedor.");
  }

  const buyerName = String(input.buyerName ?? "").trim().slice(0, 190);
  const buyerPhone = String(input.buyerPhone ?? "").trim().slice(0, 40);
  if (!buyerName) throw new HttpError(400, "Indicá tu nombre.");
  if (digitsOnly(buyerPhone).length < 8) {
    throw new HttpError(400, "Indicá un teléfono de contacto válido.");
  }

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) throw new HttpError(400, "El carrito está vacío.");
  if (rawItems.length > 100) throw new HttpError(400, "Demasiados ítems.");

  // Unificar cantidades por producto
  const qtyById = new Map<string, number>();
  for (const raw of rawItems) {
    const productId = String(raw.productId ?? "").trim();
    if (!productId) throw new HttpError(400, "Producto inválido en el carrito.");
    const qty = Math.min(
      9999,
      Math.max(1, Math.round(Number(raw.quantity) || 1))
    );
    qtyById.set(productId, (qtyById.get(productId) ?? 0) + qty);
  }

  const products = new Map<string, CatalogPublicProduct>();
  for (const p of await loadPublicProducts(comercioId)) products.set(p.id, p);

  const items: CatalogOrderItem[] = [];
  let total = 0;
  for (const [productId, quantity] of qtyById) {
    const product = products.get(productId);
    if (!product) {
      throw new HttpError(400, `Producto no disponible: ${productId}`);
    }
    const lineTotal = Math.round(product.unitPrice * quantity * 100) / 100;
    items.push({
      productId: product.id,
      name: product.name,
      quantity,
      unitPrice: product.unitPrice,
      currency: product.currency,
      lineTotal,
    });
    total += lineTotal;
  }
  total = Math.round(total * 100) / 100;
  const currency = items[0]?.currency ?? DEFAULT_CURRENCY;

  const now = new Date();
  const expires = new Date(
    now.getTime() + settings.orderTtlHours * 60 * 60 * 1000
  );
  const id = nextCatalogOrderId();

  await execute(
    `INSERT INTO catalog_orders (
      id, comercio_id, status, expires_at, buyer_name, buyer_phone, buyer_note,
      items_json, currency, total, whatsapp_sent_at, created_at, updated_at
    ) VALUES (?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [
      id,
      comercioId,
      toMysqlUtc(expires),
      buyerName,
      buyerPhone,
      String(input.buyerNote ?? "").trim().slice(0, 2000),
      JSON.stringify(items),
      currency,
      total,
    ]
  );

  const order = await getCatalogOrder(comercioId, id);
  if (!order) throw new HttpError(500, "No se pudo crear el pedido.");
  return { order, waUrl: buildWhatsAppOrderUrl(phone, order) };
}
