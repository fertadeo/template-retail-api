import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getComercio, getDefaultComercioId } from "./comercios.js";
import { getDefaultPriceListId } from "./price-lists.js";

export type CatalogSettings = {
  publicEnabled: boolean;
  whatsappPhone: string;
  displayName: string;
  welcomeText: string;
  currency: "ARS" | "MXN" | "USD" | "UYU";
  orderTtlHours: number;
};
export type PublicProduct = {
  id: string;
  name: string;
  sku: string;
  category: string;
  categoryName: string;
  description: string;
  unitPrice: number;
  currency: string;
  stock: number;
  imageUrl: string | null;
  images?: Array<{
    id: string;
    url: string;
    thumbnailUrl: string;
    alt: string;
  }>;
};
export type CartInput = {
  productId: string;
  quantity: number;
  expectedUnitPrice: number;
};
export type CartItem = {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  stock: number;
  available: boolean;
  imageUrl: string | null;
};
export type CartIssue = {
  productId: string;
  kind: "unavailable" | "stock" | "price";
  message: string;
};
export type CatalogOrderStatus =
  | "pendiente"
  | "en_preparacion"
  | "listo_para_entrega"
  | "entregado"
  | "devolucion"
  | "cancelado"
  | "cobrado";
export type CatalogOrder = {
  id: string;
  status: CatalogOrderStatus;
  expiresAt: string;
  buyerName: string;
  buyerPhone: string;
  buyerNote: string;
  items: CartItem[];
  currency: string;
  total: number;
  createdAt: string;
  payment: { status: string; method: string | null; reference: string | null };
};
export type CheckoutInput = {
  checkoutKey: string;
  expectedCurrency: string;
  buyerName: string;
  buyerPhone: string;
  buyerNote: string;
  items: CartInput[];
};
const keys: Record<keyof CatalogSettings, string> = {
  publicEnabled: "catalog_public_enabled",
  whatsappPhone: "catalog_whatsapp_phone",
  displayName: "catalog_display_name",
  welcomeText: "catalog_welcome_text",
  currency: "catalog_currency",
  orderTtlHours: "catalog_order_ttl_hours",
};
let settingsCache: {
  cid: string;
  expires: number;
  settings: CatalogSettings;
} | null = null;
export const digits = (value: string) => value.replace(/\D/g, "");
export const validPhone = (value: string) =>
  /^\+?[\d\s().-]+$/.test(value.trim()) &&
  /^[1-9]\d{7,14}$/.test(digits(value));

export async function getCatalogSettings(
  cid: string,
): Promise<CatalogSettings> {
  if (settingsCache?.cid === cid && settingsCache.expires > Date.now())
    return { ...settingsCache.settings };
  const rows = await query<
    (RowDataPacket & { setting_key: string; value_text: string | null })[]
  >(
    "SELECT setting_key, value_text FROM retail_settings WHERE comercio_id = ? AND setting_key LIKE 'catalog_%'",
    [cid],
  );
  const values = new Map(
    rows.map((row) => [row.setting_key, row.value_text ?? ""]),
  );
  const currency = values.get(keys.currency) ?? "ARS";
  const ttl = Number(values.get(keys.orderTtlHours) || 24);
  const settings: CatalogSettings = {
    publicEnabled: ["1", "true"].includes(values.get(keys.publicEnabled) ?? ""),
    whatsappPhone: values.get(keys.whatsappPhone) ?? "",
    displayName: values.get(keys.displayName) ?? "",
    welcomeText:
      values.get(keys.welcomeText) ??
      "Elegí tus favoritos. Coordinamos tu pedido por WhatsApp.",
    currency: ["ARS", "MXN", "USD", "UYU"].includes(currency)
      ? (currency as CatalogSettings["currency"])
      : "ARS",
    orderTtlHours: Number.isFinite(ttl)
      ? Math.max(1, Math.min(168, Math.round(ttl)))
      : 24,
  };
  settingsCache = { cid, expires: Date.now() + 15_000, settings };
  return { ...settings };
}
export async function saveCatalogSettings(
  cid: string,
  settings: CatalogSettings,
) {
  if (settings.publicEnabled && !validPhone(settings.whatsappPhone))
    throw new HttpError(
      400,
      "Configurá un WhatsApp válido con código de país antes de publicar.",
    );
  await withTransaction(async (conn) => {
    for (const key of Object.keys(keys) as Array<keyof CatalogSettings>) {
      const value =
        key === "whatsappPhone"
          ? digits(settings.whatsappPhone)
          : key === "publicEnabled"
            ? settings.publicEnabled
              ? "1"
              : "0"
            : String(settings[key]);
      await conn.execute(
        `INSERT INTO retail_settings (comercio_id, setting_key, value_text) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE value_text = VALUES(value_text)`,
        [cid, keys[key], value],
      );
    }
  });
  settingsCache = null;
  return getCatalogSettings(cid);
}
async function publicContext() {
  const cid =
    settingsCache && settingsCache.expires > Date.now()
      ? settingsCache.cid
      : await getDefaultComercioId();
  const settings = await getCatalogSettings(cid);
  if (!settings.publicEnabled)
    throw new HttpError(404, "El catálogo no está disponible por el momento.");
  return { cid, settings };
}

// Whitelisted projection: no costs, supplier data, private price lists or base64 files.
const PRICE = "COALESCE(pp.precio, p.precio_default)";
const FROM = `FROM products p LEFT JOIN categories c ON c.comercio_id = p.comercio_id AND c.codigo = p.categoria
  LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = ?`;
const VISIBLE = `p.comercio_id = ? AND p.activo = 1 AND p.stock > 0 AND ${PRICE} > 0 AND (c.id IS NULL OR c.activa = 1)`;
const SELECT = `p.id, p.nombre, p.sku, p.categoria, COALESCE(c.nombre, p.categoria) AS category_name,
  p.descripcion, p.stock, ${PRICE} AS price`;
type ProductRow = RowDataPacket & {
  id: string;
  nombre: string;
  sku: string;
  categoria: string;
  category_name: string;
  descripcion: string;
  stock: number;
  price: string | number;
};
type ImageRow = RowDataPacket & {
  id: string;
  product_id: string;
  title: string;
  is_primary: number;
};
const imageUrl = (id: string, thumbnail = false) =>
  `/api/catalog/public/media/${encodeURIComponent(id)}${thumbnail ? "?thumbnail=1" : ""}`;
async function productImages(ids: string[], all = false) {
  if (!ids.length) return new Map<string, ImageRow[]>();
  // A deterministic first image also handles legacy products without a marked primary.
  const rows = await query<ImageRow[]>(
    `SELECT id, product_id, title, is_primary FROM media_assets
    WHERE product_id IN (${ids.map(() => "?").join(",")}) AND kind = 'image' AND mime LIKE 'image/%'
    ORDER BY is_primary DESC, sort_order ASC, uploaded_at ASC, id ASC`,
    ids,
  );
  const map = new Map<string, ImageRow[]>();
  for (const row of rows) {
    const bag = map.get(row.product_id) ?? [];
    if (all || !bag.length) bag.push(row);
    map.set(row.product_id, bag);
  }
  return map;
}
function product(
  row: ProductRow,
  currency: string,
  images: ImageRow[] = [],
  detail = false,
): PublicProduct {
  return {
    id: row.id,
    name: row.nombre,
    sku: row.sku,
    category: row.categoria,
    categoryName: row.category_name,
    description: detail ? row.descripcion : "",
    unitPrice: Number(row.price),
    currency,
    stock: Number(row.stock),
    imageUrl: images[0] ? imageUrl(images[0].id, true) : null,
    ...(detail
      ? {
          images: images.map((image) => ({
            id: image.id,
            url: imageUrl(image.id),
            thumbnailUrl: imageUrl(image.id, true),
            alt: image.title || row.nombre,
          })),
        }
      : {}),
  };
}
export async function publicCatalogInfo() {
  const { cid, settings } = await publicContext();
  const [business, listId] = await Promise.all([
    getComercio(cid),
    getDefaultPriceListId(cid),
  ]);
  const rows = await query<
    (RowDataPacket & { id: string; name: string; count: number })[]
  >(
    `SELECT p.categoria AS id, COALESCE(c.nombre, p.categoria) AS name, COUNT(*) AS count
    ${FROM} WHERE ${VISIBLE} GROUP BY p.categoria, c.nombre ORDER BY name`,
    [listId, cid],
  );
  return {
    id: createHash("sha256").update(cid).digest("hex").slice(0, 16),
    name: settings.displayName || business?.nombre || "Nuestro local",
    welcomeText: settings.welcomeText,
    address: business?.direccion || "",
    currency: settings.currency,
    whatsappConfigured: validPhone(settings.whatsappPhone),
    orderTtlHours: settings.orderTtlHours,
    categories: rows.map((row) => ({ ...row, count: Number(row.count) })),
    total: rows.reduce((sum, row) => sum + Number(row.count), 0),
    checkout: { channel: "whatsapp" as const, onlinePayments: false },
  };
}
export async function publicProducts(options: {
  page: number;
  pageSize: number;
  q: string;
  category: string;
  sort: "name" | "price_asc" | "price_desc" | "recent";
}) {
  const { cid, settings } = await publicContext();
  const listId = await getDefaultPriceListId(cid);
  const where = [VISIBLE];
  const params: (string | number)[] = [listId, cid];
  if (options.category) {
    where.push("p.categoria = ?");
    params.push(options.category);
  }
  if (options.q) {
    where.push("(p.nombre LIKE ? ESCAPE '!' OR p.sku LIKE ? ESCAPE '!')");
    const term = `%${options.q.replace(/[!%_]/g, "!$&")}%`;
    params.push(term, term);
  }
  const order = {
    name: "p.nombre ASC",
    price_asc: "price ASC",
    price_desc: "price DESC",
    recent: "p.created_at DESC",
  }[options.sort];
  // Descriptions and binary files are not needed for browsing.
  const rows = await query<ProductRow[]>(
    `SELECT p.id, p.nombre, p.sku, p.categoria,
    COALESCE(c.nombre, p.categoria) AS category_name, '' AS descripcion, p.stock, ${PRICE} AS price
    ${FROM} WHERE ${where.join(" AND ")} ORDER BY EXISTS (SELECT 1 FROM media_assets cover WHERE cover.product_id = p.id
      AND cover.kind = 'image' AND cover.mime LIKE 'image/%') DESC, ${order}, p.id ASC
    LIMIT ${options.pageSize + 1} OFFSET ${(options.page - 1) * options.pageSize}`,
    params,
  );
  const selected = rows.slice(0, options.pageSize);
  const images = await productImages(selected.map((row) => row.id));
  return {
    items: selected.map((row) =>
      product(row, settings.currency, images.get(row.id)),
    ),
    page: options.page,
    pageSize: options.pageSize,
    hasMore: rows.length > options.pageSize,
  };
}
export async function publicProduct(id: string) {
  const { cid, settings } = await publicContext();
  const listId = await getDefaultPriceListId(cid);
  const rows = await query<ProductRow[]>(
    `SELECT ${SELECT} ${FROM} WHERE ${VISIBLE} AND p.id = ? LIMIT 1`,
    [listId, cid, id],
  );
  if (!rows[0])
    throw new HttpError(404, "Este producto ya no está disponible.");
  const images = await productImages([id], true);
  return product(rows[0], settings.currency, images.get(id), true);
}
export async function publicMediaScope() {
  return (await publicContext()).cid;
}

function normalizeItems(items: CartInput[]) {
  const sorted = [...items].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  );
  if (new Set(sorted.map((item) => item.productId)).size !== sorted.length)
    throw new HttpError(400, "Hay productos repetidos en el carrito.");
  return sorted;
}
async function review(cid: string, currency: string, input: CartInput[]) {
  const listId = await getDefaultPriceListId(cid);
  const rows = await query<ProductRow[]>(
    `SELECT ${SELECT} ${FROM} WHERE ${VISIBLE}
    AND p.id IN (${input.map(() => "?").join(",")})`,
    [listId, cid, ...input.map((item) => item.productId)],
  );
  const map = new Map(rows.map((row) => [row.id, row]));
  const images = await productImages(rows.map((row) => row.id));
  const issues: CartIssue[] = [];
  const items = input.map((line) => {
    const row = map.get(line.productId);
    const price = row ? Number(row.price) : 0;
    const item: CartItem = {
      productId: line.productId,
      name: row?.nombre || "Producto no disponible",
      sku: row?.sku || "",
      quantity: line.quantity,
      unitPrice: price,
      lineTotal: (Math.round(price * 100) * line.quantity) / 100,
      stock: Number(row?.stock ?? 0),
      available: Boolean(row),
      imageUrl: images.get(line.productId)?.[0]
        ? imageUrl(images.get(line.productId)![0].id, true)
        : null,
    };
    if (!row)
      issues.push({
        productId: line.productId,
        kind: "unavailable",
        message: "Ya no está disponible. Quitalo para continuar.",
      });
    else if (line.quantity > Number(row.stock))
      issues.push({
        productId: line.productId,
        kind: "stock",
        message: `Hay ${row.stock} unidades disponibles. Ajustá la cantidad.`,
      });
    if (
      row &&
      Math.round(line.expectedUnitPrice * 100) !== Math.round(price * 100)
    )
      issues.push({
        productId: line.productId,
        kind: "price",
        message: "El precio cambió. Revisá el nuevo total antes de continuar.",
      });
    return item;
  });
  const total =
    Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) /
    100;
  if (!Number.isFinite(total) || total > 9999999999.99)
    throw new HttpError(
      400,
      "El total del pedido supera el límite permitido. Reducí las cantidades para continuar.",
    );
  return { items, currency, total, issues, valid: issues.length === 0 };
}
export async function reviewPublicCart(
  input: CartInput[],
  expectedCurrency: string,
) {
  const { cid, settings } = await publicContext();
  if (settings.currency !== expectedCurrency)
    throw new HttpError(
      409,
      "Cambió la moneda del catálogo. Actualizá la página antes de continuar.",
    );
  return review(cid, settings.currency, normalizeItems(input));
}

type OrderRow = RowDataPacket & {
  id: string;
  status: CatalogOrderStatus;
  buyer_name: string;
  buyer_phone: string;
  buyer_note: string;
  items_json: string;
  currency: string;
  total: string | number;
  expires_iso: string;
  created_iso: string;
  checkout_key: string | null;
  request_hash: string | null;
  payment_status: string;
  payment_method: string | null;
  payment_reference: string | null;
};
const ORDER_FIELDS = `id, status, buyer_name, buyer_phone, buyer_note, items_json, currency, total,
  checkout_key, request_hash, payment_status, payment_method, payment_reference,
  DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.000Z') AS expires_iso,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_iso`;
function normalizedStatus(status: string): CatalogOrderStatus {
  if (status === "confirmado") return "en_preparacion";
  if (status === "vencido") return "pendiente";
  return status as CatalogOrderStatus;
}
function mapOrder(row: OrderRow): CatalogOrder {
  return {
    id: row.id,
    status: normalizedStatus(row.status),
    expiresAt: row.expires_iso,
    buyerName: row.buyer_name,
    buyerPhone: row.buyer_phone,
    buyerNote: row.buyer_note,
    items: JSON.parse(row.items_json) as CartItem[],
    currency: row.currency,
    total: Number(row.total),
    createdAt: row.created_iso,
    payment: {
      status: row.payment_status,
      method: row.payment_method,
      reference: row.payment_reference,
    },
  };
}
async function byCheckoutKey(conn: PoolConnection, cid: string, key: string) {
  const [rows] = await conn.execute<OrderRow[]>(
    `SELECT ${ORDER_FIELDS} FROM catalog_orders WHERE comercio_id = ? AND checkout_key = ? LIMIT 1`,
    [cid, key],
  );
  return rows[0];
}
export function whatsappOrderUrl(phone: string, order: CatalogOrder) {
  const money = (value: number) =>
    new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: order.currency,
    }).format(value);
  const text = [
    "¡Hola! Quiero hacer este pedido:",
    `Referencia: ${order.id}`,
    "",
    ...order.items.map(
      (item) =>
        `${item.quantity} × ${item.name.slice(0, 48)}${item.sku ? ` [${item.sku.slice(0, 20)}]` : ""} — ${money(item.lineTotal)}`,
    ),
    "",
    `Total de productos: ${money(order.total)}`,
    `Nombre: ${order.buyerName}`,
    `Contacto: ${order.buyerPhone}`,
    ...(order.buyerNote ? [`Nota: ${order.buyerNote.slice(0, 350)}`] : []),
    "Disponibilidad y entrega a confirmar con el local.",
  ].join("\n");
  return `https://wa.me/${digits(phone)}?text=${encodeURIComponent(text)}`;
}
export async function createPublicOrder(input: CheckoutInput) {
  const { cid, settings } = await publicContext();
  if (!validPhone(settings.whatsappPhone))
    throw new HttpError(
      409,
      "El local todavía no configuró su WhatsApp para recibir pedidos.",
    );
  const normalized = {
    currency: input.expectedCurrency,
    buyerName: input.buyerName.trim(),
    buyerPhone: digits(input.buyerPhone),
    buyerNote: input.buyerNote.trim(),
    items: normalizeItems(input.items),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  // Retries return the same stored snapshot, even if a later catalog price changes.
  const existing = await query<OrderRow[]>(
    `SELECT ${ORDER_FIELDS} FROM catalog_orders WHERE comercio_id = ? AND checkout_key = ? LIMIT 1`,
    [cid, input.checkoutKey],
  );
  if (existing[0])
    return checkoutResult(existing[0], hash, settings.whatsappPhone);
  if (settings.currency !== input.expectedCurrency)
    throw new HttpError(
      409,
      "Cambió la moneda del catálogo. Actualizá la página antes de continuar.",
    );
  const cart = await review(cid, settings.currency, normalized.items);
  if (!cart.valid) return { conflict: true as const, cart };
  const row = await withTransaction(async (conn) => {
    const id = `ord_${randomUUID().replace(/-/g, "")}`;
    await conn.execute(
      `INSERT INTO catalog_orders
      (id, comercio_id, status, expires_at, buyer_name, buyer_phone, buyer_note, items_json, currency, total, checkout_key, request_hash, payment_status, created_at, updated_at)
      VALUES (?, ?, 'pendiente', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested', UTC_TIMESTAMP(), UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE id = id`,
      [
        id,
        cid,
        settings.orderTtlHours,
        normalized.buyerName,
        normalized.buyerPhone,
        normalized.buyerNote,
        JSON.stringify(cart.items),
        settings.currency,
        cart.total,
        input.checkoutKey,
        hash,
      ],
    );
    return byCheckoutKey(conn, cid, input.checkoutKey);
  });
  if (!row)
    throw new HttpError(
      500,
      "No se pudo registrar el pedido. Intentá nuevamente.",
    );
  return checkoutResult(row, hash, settings.whatsappPhone);
}
function checkoutResult(row: OrderRow, hash: string, phone: string) {
  if (row.request_hash !== hash)
    throw new HttpError(
      409,
      "El intento ya fue usado con otros datos. Volvé a revisar el carrito.",
    );
  if (
    new Date(row.expires_iso).getTime() <= Date.now() ||
    row.status === "cancelado"
  )
    throw new HttpError(
      410,
      "Este pedido ya venció o fue cancelado. Volvé a preparar tu pedido.",
    );
  const order = mapOrder(row);
  return {
    conflict: false as const,
    order,
    whatsappUrl: whatsappOrderUrl(phone, order),
  };
}
export async function listCatalogOrders(
  cid: string,
  options: { page: number; pageSize: number; status?: string; q?: string },
) {
  const effectiveStatus =
    "CASE WHEN status = 'confirmado' THEN 'en_preparacion' WHEN status = 'vencido' THEN 'pendiente' ELSE status END";
  const where = ["comercio_id = ?"];
  const params: string[] = [cid];
  if (options.status) {
    where.push(`(${effectiveStatus}) = ?`);
    params.push(options.status);
  }
  if (options.q) {
    const term = `%${options.q.replace(/[!%_]/g, "!$&")}%`;
    where.push(
      "(id LIKE ? ESCAPE '!' OR buyer_name LIKE ? ESCAPE '!' OR buyer_phone LIKE ? ESCAPE '!')",
    );
    params.push(term, term, term);
  }
  // Expiration is projected, not a write on every list request.
  const rows = await query<OrderRow[]>(
    `SELECT ${ORDER_FIELDS.replace("id, status,", `id, ${effectiveStatus} AS status,`)}
    FROM catalog_orders WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT ${options.pageSize + 1} OFFSET ${(options.page - 1) * options.pageSize}`,
    params,
  );
  return {
    orders: rows.slice(0, options.pageSize).map(mapOrder),
    page: options.page,
    hasMore: rows.length > options.pageSize,
  };
}
export async function updateCatalogOrder(
  cid: string,
  id: string,
  status: Exclude<CatalogOrderStatus, "cobrado">,
) {
  const allowed: Record<string, string[]> = {
    pendiente: ["en_preparacion", "cancelado"],
    en_preparacion: ["listo_para_entrega", "cancelado"],
    listo_para_entrega: ["en_preparacion", "entregado", "cancelado"],
    entregado: ["devolucion"],
  };
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<OrderRow[]>(
      `SELECT ${ORDER_FIELDS} FROM catalog_orders WHERE id = ? AND comercio_id = ? FOR UPDATE`,
      [id, cid],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Pedido no encontrado.");
    row.status = normalizedStatus(row.status);
    if (status !== row.status && row.payment_status !== "not_requested")
      throw new HttpError(
        409,
        "Este pedido tiene un proceso de pago asociado y requiere una gestión específica.",
      );
    if (status !== row.status && !allowed[row.status]?.includes(status))
      throw new HttpError(409, "Este pedido no admite ese cambio de estado.");
    await conn.execute(
      "UPDATE catalog_orders SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND comercio_id = ?",
      [status, id, cid],
    );
    return { ...mapOrder(row), status };
  });
}
