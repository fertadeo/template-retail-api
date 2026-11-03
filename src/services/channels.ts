import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type {
  Channel,
  ChannelConfigPublic,
  ChannelLink,
  Product,
  StockMode,
} from "../types.js";
import { resolveChannelStock } from "./branches.js";
import { getDefaultPriceListId } from "./price-lists.js";

/** Evita import circular con products.ts */
async function loadProductForPush(productId: string): Promise<Product | null> {
  const { getProduct } = await import("./products.js");
  return getProduct(productId);
}

type ConfigRow = RowDataPacket & {
  channel: Channel;
  enabled: number;
  store_url: string | null;
  consumer_key: string | null;
  consumer_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  seller_id: string | null;
  site_id: string | null;
  price_list_id: string | null;
  stock_mode: StockMode;
  stock_branch_id: string | null;
  last_sync_at: Date | string | null;
};

type LinkRow = RowDataPacket & {
  product_id: string;
  channel: Channel;
  external_id: string;
  external_sku: string;
  sync_enabled: number;
  last_synced_at: Date | string | null;
  last_error: string | null;
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

function mapConfigPublic(row: ConfigRow): ChannelConfigPublic {
  return {
    channel: row.channel,
    enabled: Boolean(row.enabled),
    storeUrl: row.store_url,
    consumerKey: row.consumer_key,
    consumerSecretSet: Boolean(row.consumer_secret),
    consumerSecretMasked: maskSecret(row.consumer_secret),
    accessTokenSet: Boolean(row.access_token),
    accessTokenMasked: maskSecret(row.access_token),
    sellerId: row.seller_id,
    siteId: row.site_id ?? "MLA",
    priceListId: row.price_list_id,
    stockMode: row.stock_mode,
    stockBranchId: row.stock_branch_id,
    lastSyncAt: iso(row.last_sync_at),
    configured:
      row.channel === "woocommerce"
        ? Boolean(row.store_url && row.consumer_key && row.consumer_secret)
        : Boolean(row.access_token),
  };
}

function mapLink(row: LinkRow): ChannelLink {
  return {
    productId: row.product_id,
    channel: row.channel,
    externalId: row.external_id,
    externalSku: row.external_sku ?? "",
    syncEnabled: Boolean(row.sync_enabled),
    lastSyncedAt: iso(row.last_synced_at),
    lastError: row.last_error,
  };
}

async function getConfigRow(channel: Channel): Promise<ConfigRow | null> {
  const rows = await query<ConfigRow[]>(
    `SELECT * FROM channel_configs WHERE channel = ? LIMIT 1`,
    [channel]
  );
  return rows[0] ?? null;
}

export async function getChannelConfig(
  channel: Channel
): Promise<ChannelConfigPublic> {
  const row = await getConfigRow(channel);
  if (!row) {
    return {
      channel,
      enabled: false,
      storeUrl: null,
      consumerKey: null,
      consumerSecretSet: false,
      consumerSecretMasked: null,
      accessTokenSet: false,
      accessTokenMasked: null,
      sellerId: null,
      siteId: "MLA",
      priceListId: null,
      stockMode: "total",
      stockBranchId: null,
      lastSyncAt: null,
      configured: false,
    };
  }
  return mapConfigPublic(row);
}

export async function listChannelConfigs(): Promise<ChannelConfigPublic[]> {
  return Promise.all([
    getChannelConfig("woocommerce"),
    getChannelConfig("mercadolibre"),
  ]);
}

export async function saveChannelConfig(
  channel: Channel,
  input: {
    enabled?: boolean;
    storeUrl?: string | null;
    consumerKey?: string | null;
    consumerSecret?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    sellerId?: string | null;
    siteId?: string | null;
    priceListId?: string | null;
    stockMode?: StockMode;
    stockBranchId?: string | null;
  }
): Promise<ChannelConfigPublic> {
  const prev = await getConfigRow(channel);
  await query(
    `INSERT INTO channel_configs (
       channel, enabled, store_url, consumer_key, consumer_secret,
       access_token, refresh_token, seller_id, site_id,
       price_list_id, stock_mode, stock_branch_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       store_url = VALUES(store_url),
       consumer_key = VALUES(consumer_key),
       consumer_secret = COALESCE(VALUES(consumer_secret), consumer_secret),
       access_token = COALESCE(VALUES(access_token), access_token),
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
       seller_id = VALUES(seller_id),
       site_id = VALUES(site_id),
       price_list_id = VALUES(price_list_id),
       stock_mode = VALUES(stock_mode),
       stock_branch_id = VALUES(stock_branch_id)`,
    [
      channel,
      input.enabled === undefined
        ? prev?.enabled ?? 0
        : input.enabled
          ? 1
          : 0,
      input.storeUrl !== undefined
        ? input.storeUrl?.replace(/\/$/, "") || null
        : prev?.store_url ?? null,
      input.consumerKey !== undefined
        ? input.consumerKey || null
        : prev?.consumer_key ?? null,
      input.consumerSecret !== undefined && input.consumerSecret !== ""
        ? input.consumerSecret
        : null,
      input.accessToken !== undefined && input.accessToken !== ""
        ? input.accessToken
        : null,
      input.refreshToken !== undefined && input.refreshToken !== ""
        ? input.refreshToken
        : null,
      input.sellerId !== undefined
        ? input.sellerId || null
        : prev?.seller_id ?? null,
      input.siteId !== undefined
        ? input.siteId || "MLA"
        : prev?.site_id ?? "MLA",
      input.priceListId !== undefined
        ? input.priceListId || null
        : prev?.price_list_id ?? null,
      input.stockMode ?? prev?.stock_mode ?? "total",
      input.stockBranchId !== undefined
        ? input.stockBranchId || null
        : prev?.stock_branch_id ?? null,
    ]
  );
  return getChannelConfig(channel);
}

export async function listProductLinks(
  productId?: string
): Promise<ChannelLink[]> {
  const rows = productId
    ? await query<LinkRow[]>(
        `SELECT * FROM product_channel_links WHERE product_id = ?`,
        [productId]
      )
    : await query<LinkRow[]>(`SELECT * FROM product_channel_links`);
  return rows.map(mapLink);
}

export async function upsertProductLink(input: {
  productId: string;
  channel: Channel;
  externalId: string;
  externalSku?: string;
  syncEnabled?: boolean;
}): Promise<ChannelLink> {
  const exists = await query<(RowDataPacket & { id: string; sku: string })[]>(
    `SELECT id, sku FROM products WHERE id = ? LIMIT 1`,
    [input.productId]
  );
  if (!exists[0]) throw new HttpError(404, "Producto no encontrado.");
  const externalId = input.externalId.trim();
  if (!externalId) throw new HttpError(400, "externalId es obligatorio.");

  await query(
    `INSERT INTO product_channel_links
       (product_id, channel, external_id, external_sku, sync_enabled, last_error)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       external_id = VALUES(external_id),
       external_sku = VALUES(external_sku),
       sync_enabled = VALUES(sync_enabled),
       last_error = NULL`,
    [
      input.productId,
      input.channel,
      externalId,
      input.externalSku?.trim() ?? exists[0].sku,
      input.syncEnabled === false ? 0 : 1,
    ]
  );
  const rows = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links WHERE product_id = ? AND channel = ?`,
    [input.productId, input.channel]
  );
  return mapLink(rows[0]!);
}

export async function deleteProductLink(
  productId: string,
  channel: Channel
): Promise<void> {
  const result = await execute(
    `DELETE FROM product_channel_links WHERE product_id = ? AND channel = ?`,
    [productId, channel]
  );
  if (result.affectedRows === 0) {
    throw new HttpError(404, "Vínculo no encontrado.");
  }
}

async function touchLink(
  productId: string,
  channel: Channel,
  error: string | null
): Promise<void> {
  await query(
    `UPDATE product_channel_links
     SET last_synced_at = CASE WHEN ? IS NULL THEN CURRENT_TIMESTAMP(3) ELSE last_synced_at END,
         last_error = ?
     WHERE product_id = ? AND channel = ?`,
    [error, error, productId, channel]
  );
  if (!error) {
    await query(
      `UPDATE channel_configs SET last_sync_at = CURRENT_TIMESTAMP(3) WHERE channel = ?`,
      [channel]
    );
  }
}

async function resolvePushPrice(
  product: Product,
  priceListId: string | null
): Promise<number> {
  const listId = priceListId || (await getDefaultPriceListId());
  return product.precios[listId] ?? product.precio;
}

/* —— WooCommerce —— */

async function wooRequestRaw(
  cfg: ConfigRow,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<{ data: unknown; headers: Headers }> {
  if (!cfg.store_url || !cfg.consumer_key || !cfg.consumer_secret) {
    throw new HttpError(400, "WooCommerce no está configurado.");
  }
  const url = `${cfg.store_url.replace(/\/$/, "")}/wp-json/wc/v3${endpoint}`;
  const auth = Buffer.from(
    `${cfg.consumer_key}:${cfg.consumer_secret}`,
    "utf8"
  ).toString("base64");
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(
      502,
      `Respuesta inválida de WooCommerce: ${text.slice(0, 180)}`
    );
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new HttpError(502, `WooCommerce: ${msg}`);
  }
  return { data, headers: res.headers };
}

async function wooRequest<T>(
  cfg: ConfigRow,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const { data } = await wooRequestRaw(cfg, method, endpoint, body);
  return data as T;
}

type WooRemoteImage = {
  id?: number;
  src?: string;
  name?: string;
  alt?: string;
};

type WooRemoteProduct = {
  id: number;
  name: string;
  sku: string;
  description?: string;
  short_description?: string;
  regular_price?: string;
  stock_quantity?: number | null;
  manage_stock?: boolean;
  stock_status?: string;
  status?: string;
  type?: string;
  images?: WooRemoteImage[];
};

/** Incluye privados/borradores: status=any a veces lo filtra un proxy; listamos explícito. */
const WOO_PULL_STATUSES = "publish,private,draft,pending";

function wooImageList(item: WooRemoteProduct): WooRemoteImage[] {
  return Array.isArray(item.images) ? item.images : [];
}

function wooHasUsableImage(item: WooRemoteProduct): boolean {
  return wooImageList(item).some((img) => {
    const src = String(img?.src ?? "").trim();
    return Boolean(src) && (/^https?:\/\//i.test(src) || src.startsWith("//"));
  });
}

async function fetchWooProductById(
  cfg: ConfigRow,
  id: number
): Promise<WooRemoteProduct | null> {
  try {
    return await wooRequest<WooRemoteProduct>(
      cfg,
      "GET",
      `/products/${id}?context=edit`
    );
  } catch {
    return null;
  }
}

/**
 * Si el listado no trae imágenes (pasa con algunos privados / caches),
 * pide el producto suelto. No cambia el resto del payload.
 */
async function ensureWooProductImages(
  cfg: ConfigRow,
  item: WooRemoteProduct
): Promise<WooRemoteProduct> {
  if (wooHasUsableImage(item)) return item;
  const full = await fetchWooProductById(cfg, item.id);
  if (!full) return item;
  return {
    ...item,
    images: wooImageList(full).length ? full.images : item.images,
  };
}

async function fetchAllWooProducts(
  cfg: ConfigRow
): Promise<WooRemoteProduct[]> {
  const perPage = 100;
  const out: WooRemoteProduct[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 50) {
    const { data, headers } = await wooRequestRaw(
      cfg,
      "GET",
      `/products?per_page=${perPage}&page=${page}&status=${encodeURIComponent(WOO_PULL_STATUSES)}&context=edit`
    );
    const batch = Array.isArray(data) ? (data as WooRemoteProduct[]) : [];
    out.push(...batch);
    const tp = Number(headers.get("x-wp-totalpages") || "1");
    totalPages = Number.isFinite(tp) && tp > 0 ? tp : 1;
    if (batch.length === 0) break;
    page += 1;
  }
  return out;
}

export async function pushProductToWooCommerce(
  productId: string,
  mode: "stock" | "price" | "both" | "full" = "both"
): Promise<{ externalId: string; stock: number; price: number }> {
  const cfg = await getConfigRow("woocommerce");
  if (!cfg || !cfg.enabled) {
    throw new HttpError(400, "Canal WooCommerce deshabilitado.");
  }
  const product = await loadProductForPush(productId);
  if (!product) throw new HttpError(404, "Producto no encontrado.");

  const links = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links
     WHERE product_id = ? AND channel = 'woocommerce' LIMIT 1`,
    [productId]
  );
  let link = links[0];
  const stock = await resolveChannelStock(
    productId,
    cfg.stock_mode,
    cfg.stock_branch_id
  );
  const price = await resolvePushPrice(product, cfg.price_list_id);

  const payload: Record<string, unknown> = {
    name: product.nombre,
    sku: product.sku,
    status: product.activo ? "publish" : "draft",
    type: "simple",
    description: product.descripcion || undefined,
  };
  if (mode === "stock" || mode === "both" || mode === "full") {
    payload.manage_stock = true;
    payload.stock_quantity = stock;
    payload.stock_status = stock > 0 ? "instock" : "outofstock";
  }
  if (mode === "price" || mode === "both" || mode === "full") {
    payload.regular_price = String(price);
  }

  try {
    let externalId = link?.external_id;
    if (externalId) {
      await wooRequest(cfg, "PUT", `/products/${externalId}`, payload);
    } else {
      const created = await wooRequest<{ id: number }>(
        cfg,
        "POST",
        "/products",
        payload
      );
      externalId = String(created.id);
      link = {
        product_id: productId,
        channel: "woocommerce",
        external_id: externalId,
        external_sku: product.sku,
        sync_enabled: 1,
        last_synced_at: null,
        last_error: null,
      } as LinkRow;
      await upsertProductLink({
        productId,
        channel: "woocommerce",
        externalId,
        externalSku: product.sku,
      });
    }
    await touchLink(productId, "woocommerce", null);
    return { externalId: externalId!, stock, price };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error de sync";
    await touchLink(productId, "woocommerce", msg.slice(0, 500));
    throw err;
  }
}

export async function linkWooCommerceBySku(): Promise<{
  linked: number;
  skipped: number;
}> {
  const cfg = await getConfigRow("woocommerce");
  if (!cfg || !cfg.enabled) {
    throw new HttpError(400, "Canal WooCommerce deshabilitado.");
  }
  const remote = await fetchAllWooProducts(cfg);

  const products = await query<(RowDataPacket & { id: string; sku: string })[]>(
    `SELECT id, sku FROM products`
  );
  const bySku = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]));
  let linked = 0;
  let skipped = 0;

  for (const item of remote) {
    const sku = String(item.sku ?? "").trim().toUpperCase();
    if (!sku) {
      skipped += 1;
      continue;
    }
    const productId = bySku.get(sku);
    if (!productId) {
      skipped += 1;
      continue;
    }
    await upsertProductLink({
      productId,
      channel: "woocommerce",
      externalId: String(item.id),
      externalSku: sku,
    });
    linked += 1;
  }
  return { linked, skipped };
}

/**
 * Trae productos de WooCommerce → catálogo local.
 * Destino de precio/sucursal: opts > config del canal > defaults.
 * - Si el SKU existe: actualiza nombre/precio/stock y vincula.
 * - Si no existe: crea el producto y vincula.
 */
export type WooSkipReason = {
  /** Tipo WC: variable | grouped | external | variation | … */
  type: string;
  label: string;
  count: number;
  explanation: string;
};

export type WooPullResult = {
  dryRun: boolean;
  /** Total de ítems leídos en WooCommerce. */
  found: number;
  /** Simples elegibles para importar (excluye variables/agrupados). */
  eligible: number;
  /** Elegibles cuyo SKU ya existe en el comercio destino. */
  matched: number;
  /** Elegibles nuevos (no coinciden por SKU). */
  toCreate: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  /** Productos a los que se asoció ≥1 imagen remota (solo write). */
  imagesSynced: number;
  /** Elegibles simples sin URL de imagen usable en la respuesta WC. */
  imagesMissing: number;
  /** Desglose de omitidos por tipo de producto WC. */
  skippedByType: WooSkipReason[];
  /** Resumen legible de por qué se omiten. */
  skipSummary: string;
  priceListId: string;
  branchId: string | null;
  comercio: {
    id: string;
    codigo: string;
    nombre: string;
  };
  errors: Array<{ sku: string; error: string }>;
};

const WOO_TYPE_META: Record<
  string,
  { label: string; explanation: string }
> = {
  variable: {
    label: "Variables (padre)",
    explanation:
      "Son el producto padre con atributos; las variantes concretas no vienen como ítems simples en este listado. Hoy solo importamos tipo «simple».",
  },
  variation: {
    label: "Variaciones",
    explanation:
      "Variantes hijas (talla/color/etc.). Requieren endpoint de variaciones; aún no se importan.",
  },
  grouped: {
    label: "Agrupados",
    explanation: "Packs/grupos de otros productos; no se importan como ítem único.",
  },
  external: {
    label: "Externos / afiliado",
    explanation: "Productos que enlazan a otra tienda; no tienen stock local importable.",
  },
};

function describeWooType(type: string): { label: string; explanation: string } {
  const key = type.trim().toLowerCase() || "unknown";
  return (
    WOO_TYPE_META[key] ?? {
      label: `Tipo «${key}»`,
      explanation: "Tipo no soportado: solo se importan productos WooCommerce de tipo «simple».",
    }
  );
}

function buildSkipBreakdown(
  counts: Map<string, number>
): { skippedByType: WooSkipReason[]; skipSummary: string } {
  const skippedByType: WooSkipReason[] = [...counts.entries()]
    .map(([type, count]) => {
      const meta = describeWooType(type);
      return {
        type,
        label: meta.label,
        count,
        explanation: meta.explanation,
      };
    })
    .sort((a, b) => b.count - a.count);

  const total = skippedByType.reduce((a, r) => a + r.count, 0);
  const skipSummary =
    total === 0
      ? "No se omitió ningún producto."
      : `Se omiten ${total} porque no son tipo «simple»` +
        (skippedByType.length
          ? `: ${skippedByType
              .map((r) => `${r.label} (${r.count})`)
              .join(", ")}.`
          : ".");

  return { skippedByType, skipSummary };
}

export async function pullProductsFromWooCommerce(opts?: {
  comercioId?: string;
  priceListId?: string | null;
  branchId?: string | null;
  /** Solo escanea WC y calcula coincidencias; no escribe. */
  dryRun?: boolean;
}): Promise<WooPullResult> {
  const cfg = await getConfigRow("woocommerce");
  if (!cfg || !cfg.enabled) {
    throw new HttpError(400, "Canal WooCommerce deshabilitado.");
  }

  const { getDefaultComercioId, getComercio } = await import("./comercios.js");
  const { getProductStockByBranch } = await import("./branches.js");
  const { upsertProduct, getProduct } = await import("./products.js");
  const { syncProductImagesFromUrls } = await import("./media.js");
  const comercioId = opts?.comercioId || (await getDefaultComercioId());
  const comercio = await getComercio(comercioId);
  if (!comercio) throw new HttpError(404, "Comercio destino no encontrado.");

  const priceListId =
    opts?.priceListId ||
    cfg.price_list_id ||
    (await getDefaultPriceListId(comercioId));

  // Stock vive en el comercio (products.stock). Sucursal solo si el cliente la pide.
  const branchId =
    opts?.branchId?.trim() ||
    cfg.stock_branch_id ||
    null;

  const remote = await fetchAllWooProducts(cfg);
  const local = await query<(RowDataPacket & { id: string; sku: string })[]>(
    `SELECT id, sku FROM products WHERE comercio_id = ? OR comercio_id IS NULL`,
    [comercioId]
  );
  const bySku = new Map(local.map((p) => [p.sku.toUpperCase(), p.id]));

  const found = remote.length;
  let eligible = 0;
  let matched = 0;
  let imagesMissingPreview = 0;
  const skipTypeCounts = new Map<string, number>();
  for (const item of remote) {
    const type = String(item.type ?? "simple").trim().toLowerCase() || "simple";
    if (type !== "simple") {
      skipTypeCounts.set(type, (skipTypeCounts.get(type) ?? 0) + 1);
      continue;
    }
    eligible += 1;
    const skuRaw = String(item.sku ?? "").trim();
    const sku = skuRaw.toUpperCase() || `WC-${item.id}`;
    if (bySku.has(sku)) matched += 1;
    if (!wooHasUsableImage(item)) imagesMissingPreview += 1;
  }
  const toCreate = Math.max(0, eligible - matched);
  const { skippedByType, skipSummary } = buildSkipBreakdown(skipTypeCounts);
  const skipped = skippedByType.reduce((a, r) => a + r.count, 0);

  const baseMeta = {
    dryRun: Boolean(opts?.dryRun),
    found,
    eligible,
    matched,
    toCreate,
    skipped,
    imagesSynced: 0,
    imagesMissing: imagesMissingPreview,
    skippedByType,
    skipSummary,
    priceListId,
    branchId,
    comercio: {
      id: comercio.id,
      codigo: comercio.codigo,
      nombre: comercio.nombre,
    },
  };

  if (opts?.dryRun) {
    return {
      ...baseMeta,
      created: 0,
      updated: 0,
      linked: 0,
      errors: [],
    };
  }

  let created = 0;
  let updated = 0;
  let linked = 0;
  let imagesSynced = 0;
  let imagesMissing = 0;
  const errors: Array<{ sku: string; error: string }> = [];

  for (const rawItem of remote) {
    // Solo productos simples (omitir variables/agrupados/externos)
    const type =
      String(rawItem.type ?? "simple").trim().toLowerCase() || "simple";
    if (type !== "simple") {
      continue;
    }
    // Privados/borradores incluidos: si el listado vino sin fotos, pedir ficha.
    const item = await ensureWooProductImages(cfg, rawItem);
    const skuRaw = String(item.sku ?? "").trim();
    const sku = skuRaw.toUpperCase() || `WC-${item.id}`;
    const nombre = String(item.name ?? "").trim() || `Producto WC ${item.id}`;
    const descripcion = String(
      item.short_description || item.description || ""
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    const price = Math.max(0, Number(item.regular_price) || 0);
    const stock =
      item.manage_stock && item.stock_quantity != null
        ? Math.max(0, Math.floor(Number(item.stock_quantity) || 0))
        : item.stock_status === "instock"
          ? 1
          : 0;
    // publish → activo; private/draft quedan inactivos en catálogo pero con media.
    const activo = item.status === "publish";

    try {
      let productId = bySku.get(sku) ?? null;
      if (productId) {
        const current = await getProduct(productId);
        const prevByBranch = await getProductStockByBranch(productId);
        const stockByBranch = branchId
          ? { ...prevByBranch, [branchId]: stock }
          : undefined;
        await upsertProduct({
          id: productId,
          comercioId,
          sku,
          nombre,
          categoria: current?.categoria ?? "otros",
          costo: current?.costo ?? 0,
          stock,
          stockByBranch,
          activo,
          descripcion: descripcion || current?.descripcion || "",
          precios: {
            ...(current?.precios ?? {}),
            [priceListId]: price || current?.precio || 0,
          },
        });
        updated += 1;
      } else {
        const stockByBranch = branchId ? { [branchId]: stock } : undefined;
        const createdProduct = await upsertProduct({
          comercioId,
          sku,
          nombre,
          categoria: "otros",
          costo: 0,
          stock,
          stockByBranch,
          activo,
          descripcion,
          precios: { [priceListId]: price },
        });
        productId = createdProduct.id;
        bySku.set(sku, productId);
        created += 1;
      }

      await upsertProductLink({
        productId,
        channel: "woocommerce",
        externalId: String(item.id),
        externalSku: sku,
      });
      linked += 1;

      try {
        const n = await syncProductImagesFromUrls(
          productId,
          item.images ?? [],
          {
            comercioId,
            max: 8,
          }
        );
        if (n > 0) imagesSynced += 1;
        else imagesMissing += 1;
      } catch (imgErr) {
        imagesMissing += 1;
        errors.push({
          sku,
          error: `Imágenes: ${
            imgErr instanceof Error ? imgErr.message : "Error"
          }`,
        });
      }
    } catch (err) {
      errors.push({
        sku,
        error: err instanceof Error ? err.message : "Error",
      });
    }
  }

  await execute(
    `UPDATE channel_configs SET last_sync_at = CURRENT_TIMESTAMP(3) WHERE channel = 'woocommerce'`
  );

  return {
    ...baseMeta,
    dryRun: false,
    created,
    updated,
    linked,
    imagesSynced,
    imagesMissing,
    errors,
  };
}

/**
 * Copia precios de una lista a otra (p. ej. precios traídos de WC → lista nueva).
 * Por defecto solo productos vinculados a WooCommerce.
 */
export async function migrateChannelPrices(input: {
  channel?: Channel;
  fromPriceListId: string;
  toPriceListId?: string | null;
  /** Si se indica, crea la lista destino y copia ahí. */
  newListNombre?: string;
  newListCodigo?: string;
  comercioId?: string;
  onlyLinked?: boolean;
  /** Si true (default), el canal WC pasa a usar la lista destino. */
  setAsChannelList?: boolean;
}): Promise<{
  copied: number;
  toPriceListId: string;
  toPriceListNombre: string;
}> {
  const channel = input.channel ?? "woocommerce";
  const fromId = input.fromPriceListId?.trim();
  if (!fromId) {
    throw new HttpError(400, "Indicá la lista de origen.");
  }

  const { getDefaultComercioId } = await import("./comercios.js");
  const { createPriceList, getPriceList } = await import("./price-lists.js");
  const comercioId = input.comercioId || (await getDefaultComercioId());

  let toId = input.toPriceListId?.trim() || "";
  let toNombre = "";
  if (input.newListNombre?.trim()) {
    const created = await createPriceList({
      nombre: input.newListNombre.trim(),
      codigo: input.newListCodigo,
      comercioId,
      activa: true,
      esDefault: false,
    });
    toId = created.id;
    toNombre = created.nombre;
  }
  if (!toId) {
    throw new HttpError(
      400,
      "Indicá lista destino o el nombre de una lista nueva."
    );
  }
  if (toId === fromId) {
    throw new HttpError(400, "Origen y destino deben ser distintas.");
  }

  const fromList = await getPriceList(fromId);
  const toList = await getPriceList(toId);
  if (!fromList || !toList) {
    throw new HttpError(404, "Lista de precios no encontrada.");
  }
  if (!toNombre) toNombre = toList.nombre;

  const onlyLinked = input.onlyLinked !== false;
  const rows = onlyLinked
    ? await query<
        (RowDataPacket & {
          product_id: string;
          precio: string | number;
        })[]
      >(
        `SELECT pp.product_id, pp.precio
         FROM product_prices pp
         INNER JOIN product_channel_links pcl
           ON pcl.product_id = pp.product_id AND pcl.channel = ?
         WHERE pp.price_list_id = ?`,
        [channel, fromId]
      )
    : await query<
        (RowDataPacket & {
          product_id: string;
          precio: string | number;
        })[]
      >(
        `SELECT product_id, precio FROM product_prices WHERE price_list_id = ?`,
        [fromId]
      );

  let copied = 0;
  for (const row of rows) {
    const precio = Number(row.precio) || 0;
    await execute(
      `INSERT INTO product_prices (product_id, price_list_id, precio)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE precio = VALUES(precio)`,
      [row.product_id, toId, precio]
    );
    copied += 1;
  }

  if (input.setAsChannelList !== false) {
    await execute(
      `UPDATE channel_configs SET price_list_id = ? WHERE channel = ?`,
      [toId, channel]
    );
  }

  return {
    copied,
    toPriceListId: toId,
    toPriceListNombre: toNombre,
  };
}

export async function pushAllWooCommerce(
  mode: "stock" | "price" | "both" | "full" = "both"
): Promise<Array<{ productId: string; ok: boolean; error?: string }>> {
  const links = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links
     WHERE channel = 'woocommerce' AND sync_enabled = 1`
  );
  const results: Array<{ productId: string; ok: boolean; error?: string }> = [];
  for (const link of links) {
    try {
      await pushProductToWooCommerce(link.product_id, mode);
      results.push({ productId: link.product_id, ok: true });
    } catch (err) {
      results.push({
        productId: link.product_id,
        ok: false,
        error: err instanceof Error ? err.message : "Error",
      });
    }
  }
  return results;
}

/* —— Mercado Libre —— */

async function meliRequest<T>(
  cfg: ConfigRow,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  if (!cfg.access_token) {
    throw new HttpError(400, "Mercado Libre no está configurado (access token).");
  }
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.mercadolibre.com${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.access_token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(502, `Respuesta inválida de ML: ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new HttpError(502, `Mercado Libre: ${msg}`);
  }
  return data as T;
}

type MeliItem = {
  id: string;
  title?: string;
  price?: number;
  available_quantity?: number;
  status?: string;
  seller_custom_field?: string | null;
  permalink?: string;
  thumbnail?: string;
  secure_thumbnail?: string;
  pictures?: Array<{ id?: string; url?: string; secure_url?: string }>;
  attributes?: Array<{
    id?: string;
    name?: string;
    value_name?: string | null;
    value_id?: string | null;
  }>;
};

type MeliSearchPage = {
  results?: string[];
  paging?: { total?: number; offset?: number; limit?: number };
};

async function resolveMeliSellerId(cfg: ConfigRow): Promise<{
  cfg: ConfigRow;
  sellerId: string;
}> {
  const existing = cfg.seller_id?.trim();
  if (existing) return { cfg, sellerId: existing };
  const me = await meliRequest<{ id: number | string }>(cfg, "GET", "/users/me");
  const sellerId = String(me.id ?? "").trim();
  if (!sellerId) {
    throw new HttpError(
      400,
      "No se pudo obtener el Seller ID. Pegalo en la config del canal."
    );
  }
  await execute(
    `UPDATE channel_configs SET seller_id = ? WHERE channel = 'mercadolibre'`,
    [sellerId]
  );
  return { cfg: { ...cfg, seller_id: sellerId }, sellerId };
}

/** Busca o crea la lista «Mercadolibre» del comercio (codigo mercadolibre). */
async function ensureMercadoLibrePriceList(comercioId: string): Promise<{
  id: string;
  nombre: string;
  created: boolean;
}> {
  const { listPriceLists, createPriceList } = await import("./price-lists.js");
  const lists = await listPriceLists(false, comercioId);
  const found = lists.find((l) => {
    const code = l.codigo.trim().toLowerCase();
    const name = l.nombre.trim().toLowerCase();
    return (
      code === "mercadolibre" ||
      code === "meli" ||
      name === "mercadolibre" ||
      name === "mercado libre" ||
      name === "meli"
    );
  });
  if (found) return { id: found.id, nombre: found.nombre, created: false };
  const created = await createPriceList({
    nombre: "Mercadolibre",
    codigo: "mercadolibre",
    comercioId,
    activa: true,
    esDefault: false,
  });
  return { id: created.id, nombre: created.nombre, created: true };
}

function meliItemSku(item: MeliItem): string {
  const custom = String(item.seller_custom_field ?? "").trim();
  if (custom) return custom.toUpperCase();
  for (const attr of item.attributes ?? []) {
    const id = String(attr.id ?? "").toUpperCase();
    const name = String(attr.name ?? "").toLowerCase();
    if (
      id === "SELLER_SKU" ||
      id === "SKU" ||
      id === "SELLER_SKU_CODE" ||
      name.includes("sku")
    ) {
      const v = String(attr.value_name ?? attr.value_id ?? "").trim();
      if (v) return v.toUpperCase();
    }
  }
  return String(item.id).toUpperCase();
}

function meliItemImages(
  item: MeliItem
): Array<{ src: string; name?: string; alt?: string }> {
  const out: Array<{ src: string; name?: string; alt?: string }> = [];
  for (const pic of item.pictures ?? []) {
    const src = String(pic.secure_url || pic.url || "").trim();
    if (!src) continue;
    out.push({
      src,
      name: String(pic.id ?? ""),
      alt: String(item.title ?? ""),
    });
  }
  if (!out.length) {
    const thumb = String(
      item.secure_thumbnail || item.thumbnail || ""
    ).trim();
    if (thumb) out.push({ src: thumb, alt: String(item.title ?? "") });
  }
  return out;
}

async function fetchAllMeliItemIds(
  cfg: ConfigRow,
  sellerId: string
): Promise<string[]> {
  const ids: string[] = [];
  const limit = 50;
  const base = `/users/${encodeURIComponent(sellerId)}/items/search`;

  for (const status of ["active", "paused"] as const) {
    // offset solo llega a ~1000; scan cubre catálogos más grandes (doc ML).
    let scrollId: string | null = null;
    let guard = 0;
    while (guard < 200) {
      guard += 1;
      const qs = new URLSearchParams({
        status,
        search_type: "scan",
        limit: String(limit),
      });
      if (scrollId) qs.set("scroll_id", scrollId);
      const page = await meliRequest<
        MeliSearchPage & { scroll_id?: string }
      >(cfg, "GET", `${base}?${qs.toString()}`);
      const batch = page.results ?? [];
      ids.push(...batch);
      scrollId = page.scroll_id ?? null;
      if (!batch.length || !scrollId) break;
    }

    // Fallback offset si scan no devolvió nada (cuentas/tokens viejos).
    if (!ids.length) {
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      while (offset < total && offset < 1000) {
        const page = await meliRequest<MeliSearchPage>(
          cfg,
          "GET",
          `${base}?status=${status}&offset=${offset}&limit=${limit}`
        );
        const batch = page.results ?? [];
        ids.push(...batch);
        total = Number(page.paging?.total ?? batch.length);
        if (!batch.length) break;
        offset += limit;
      }
    }
  }
  return [...new Set(ids)];
}

async function fetchMeliItemsByIds(
  cfg: ConfigRow,
  ids: string[]
): Promise<MeliItem[]> {
  const out: MeliItem[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    // /items?ids= deprecado (corte 25/10/2026) → /items/bulk?ids=
    const rows = await meliRequest<
      Array<{
        id?: string;
        code?: number;
        status_code?: number;
        body?: MeliItem;
      }>
    >(
      cfg,
      "GET",
      `/items/bulk?ids=${chunk.map(encodeURIComponent).join(",")}`
    );
    for (const row of rows) {
      const status = row.status_code ?? row.code;
      if (status === 200 && row.body?.id) out.push(row.body);
    }
  }
  return out;
}

export type MeliPullResult = {
  dryRun: boolean;
  found: number;
  eligible: number;
  matched: number;
  toCreate: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  imagesSynced: number;
  imagesMissing: number;
  skippedByType: WooSkipReason[];
  skipSummary: string;
  priceListId: string;
  priceListNombre: string;
  priceListCreated: boolean;
  branchId: string | null;
  sellerId: string;
  comercio: { id: string; codigo: string; nombre: string };
  errors: Array<{ sku: string; error: string }>;
};

/**
 * Trae publicaciones del vendedor ML → productos locales.
 * Precio va a la lista del canal o, si falta, a «Mercadolibre» (la crea si hace falta).
 * Match por SKU (seller_custom_field / atributo SKU) o por MLA… como fallback.
 */
export async function pullProductsFromMercadoLibre(opts?: {
  comercioId?: string;
  priceListId?: string | null;
  dryRun?: boolean;
}): Promise<MeliPullResult> {
  const cfg0 = await getConfigRow("mercadolibre");
  if (!cfg0 || !cfg0.enabled) {
    throw new HttpError(400, "Canal Mercado Libre deshabilitado.");
  }
  if (!cfg0.access_token) {
    throw new HttpError(400, "Falta el access token de Mercado Libre.");
  }

  const { cfg, sellerId } = await resolveMeliSellerId(cfg0);
  const { getDefaultComercioId, getComercio } = await import("./comercios.js");
  const { upsertProduct, getProduct } = await import("./products.js");
  const { syncProductImagesFromUrls } = await import("./media.js");

  const comercioId = opts?.comercioId || (await getDefaultComercioId());
  const comercio = await getComercio(comercioId);
  if (!comercio) throw new HttpError(404, "Comercio destino no encontrado.");

  let priceListId = opts?.priceListId?.trim() || cfg.price_list_id || "";
  let priceListNombre = "";
  let priceListCreated = false;
  if (priceListId) {
    const { getPriceList } = await import("./price-lists.js");
    const pl = await getPriceList(priceListId);
    if (!pl) {
      throw new HttpError(404, "Lista de precios del canal no encontrada.");
    }
    priceListNombre = pl.nombre;
  } else {
    const ensured = await ensureMercadoLibrePriceList(comercioId);
    priceListId = ensured.id;
    priceListNombre = ensured.nombre;
    priceListCreated = ensured.created;
    await execute(
      `UPDATE channel_configs SET price_list_id = ? WHERE channel = 'mercadolibre'`,
      [priceListId]
    );
  }

  const remoteIds = await fetchAllMeliItemIds(cfg, sellerId);
  const remote = await fetchMeliItemsByIds(cfg, remoteIds);

  const local = await query<(RowDataPacket & { id: string; sku: string })[]>(
    `SELECT id, sku FROM products WHERE comercio_id = ? OR comercio_id IS NULL`,
    [comercioId]
  );
  const bySku = new Map(local.map((p) => [p.sku.toUpperCase(), p.id]));

  const skipTypeCounts = new Map<string, number>();
  let eligible = 0;
  let matched = 0;
  let imagesMissingPreview = 0;

  for (const item of remote) {
    const status = String(item.status ?? "").toLowerCase();
    if (status !== "active" && status !== "paused") {
      skipTypeCounts.set(status || "other", (skipTypeCounts.get(status || "other") ?? 0) + 1);
      continue;
    }
    eligible += 1;
    const sku = meliItemSku(item);
    if (bySku.has(sku)) matched += 1;
    if (!meliItemImages(item).length) imagesMissingPreview += 1;
  }

  const toCreate = Math.max(0, eligible - matched);
  const skippedByType: WooSkipReason[] = [...skipTypeCounts.entries()]
    .map(([type, count]) => ({
      type,
      label: type === "closed" ? "Cerradas" : `Estado «${type}»`,
      count,
      explanation:
        type === "closed"
          ? "Publicaciones cerradas: no se importan."
          : "Solo se importan publicaciones active o paused.",
    }))
    .sort((a, b) => b.count - a.count);
  const skipped = skippedByType.reduce((a, r) => a + r.count, 0);
  const skipSummary =
    skipped === 0
      ? "No se omitió ninguna publicación (solo active/paused)."
      : `Se omiten ${skipped} por estado: ${skippedByType
          .map((r) => `${r.label} (${r.count})`)
          .join(", ")}.`;

  const baseMeta = {
    dryRun: Boolean(opts?.dryRun),
    found: remote.length,
    eligible,
    matched,
    toCreate,
    skipped,
    imagesSynced: 0,
    imagesMissing: imagesMissingPreview,
    skippedByType,
    skipSummary,
    priceListId,
    priceListNombre,
    priceListCreated,
    branchId: null as string | null,
    sellerId,
    comercio: {
      id: comercio.id,
      codigo: comercio.codigo,
      nombre: comercio.nombre,
    },
  };

  if (opts?.dryRun) {
    return {
      ...baseMeta,
      created: 0,
      updated: 0,
      linked: 0,
      errors: [],
    };
  }

  let created = 0;
  let updated = 0;
  let linked = 0;
  let imagesSynced = 0;
  let imagesMissing = 0;
  const errors: Array<{ sku: string; error: string }> = [];

  for (const item of remote) {
    const status = String(item.status ?? "").toLowerCase();
    if (status !== "active" && status !== "paused") continue;

    const sku = meliItemSku(item);
    const nombre = String(item.title ?? "").trim() || `Ítem ML ${item.id}`;
    const price = Math.max(0, Number(item.price) || 0);
    const stock = Math.max(0, Math.floor(Number(item.available_quantity) || 0));
    const activo = status === "active";
    const descripcion = String(item.permalink ?? "").trim().slice(0, 2000);

    try {
      let productId = bySku.get(sku) ?? null;
      if (productId) {
        const current = await getProduct(productId);
        await upsertProduct({
          id: productId,
          comercioId,
          sku,
          nombre,
          categoria: current?.categoria ?? "otros",
          costo: current?.costo ?? 0,
          stock,
          activo,
          descripcion: descripcion || current?.descripcion || "",
          precios: {
            ...(current?.precios ?? {}),
            [priceListId]: price || current?.precio || 0,
          },
        });
        updated += 1;
      } else {
        const createdProduct = await upsertProduct({
          comercioId,
          sku,
          nombre,
          categoria: "otros",
          costo: 0,
          stock,
          activo,
          descripcion,
          precios: { [priceListId]: price },
        });
        productId = createdProduct.id;
        bySku.set(sku, productId);
        created += 1;
      }

      await upsertProductLink({
        productId,
        channel: "mercadolibre",
        externalId: String(item.id),
        externalSku: sku,
      });
      linked += 1;

      try {
        const n = await syncProductImagesFromUrls(
          productId,
          meliItemImages(item),
          { comercioId, max: 8 }
        );
        if (n > 0) imagesSynced += 1;
        else imagesMissing += 1;
      } catch (imgErr) {
        imagesMissing += 1;
        errors.push({
          sku,
          error: `Imágenes: ${
            imgErr instanceof Error ? imgErr.message : "Error"
          }`,
        });
      }
    } catch (err) {
      errors.push({
        sku,
        error: err instanceof Error ? err.message : "Error",
      });
    }
  }

  await execute(
    `UPDATE channel_configs SET last_sync_at = CURRENT_TIMESTAMP(3) WHERE channel = 'mercadolibre'`
  );

  return {
    ...baseMeta,
    dryRun: false,
    created,
    updated,
    linked,
    imagesSynced,
    imagesMissing,
    errors,
  };
}

export async function pushProductToMercadoLibre(
  productId: string,
  mode: "stock" | "price" | "both" = "both"
): Promise<{ externalId: string; stock: number; price: number }> {
  const cfg = await getConfigRow("mercadolibre");
  if (!cfg || !cfg.enabled) {
    throw new HttpError(400, "Canal Mercado Libre deshabilitado.");
  }
  const product = await loadProductForPush(productId);
  if (!product) throw new HttpError(404, "Producto no encontrado.");

  const links = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links
     WHERE product_id = ? AND channel = 'mercadolibre' LIMIT 1`,
    [productId]
  );
  const link = links[0];
  if (!link?.external_id) {
    throw new HttpError(
      400,
      "Producto sin ítem de Mercado Libre vinculado. Pegá el MLA… en el vínculo."
    );
  }

  const stock = await resolveChannelStock(
    productId,
    cfg.stock_mode,
    cfg.stock_branch_id
  );
  const price = await resolvePushPrice(product, cfg.price_list_id);
  const patch: Record<string, unknown> = {};
  if (mode === "stock" || mode === "both") {
    patch.available_quantity = Math.max(0, Math.floor(stock));
  }
  if (mode === "price" || mode === "both") {
    patch.price = price;
  }

  try {
    await meliRequest(cfg, "PUT", `/items/${link.external_id}`, patch);
    await touchLink(productId, "mercadolibre", null);
    return { externalId: link.external_id, stock, price };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error de sync";
    await touchLink(productId, "mercadolibre", msg.slice(0, 500));
    throw err;
  }
}

export async function pushAllMercadoLibre(
  mode: "stock" | "price" | "both" = "both"
): Promise<Array<{ productId: string; ok: boolean; error?: string }>> {
  const links = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links
     WHERE channel = 'mercadolibre' AND sync_enabled = 1`
  );
  const results: Array<{ productId: string; ok: boolean; error?: string }> = [];
  for (const link of links) {
    try {
      await pushProductToMercadoLibre(link.product_id, mode);
      results.push({ productId: link.product_id, ok: true });
    } catch (err) {
      results.push({
        productId: link.product_id,
        ok: false,
        error: err instanceof Error ? err.message : "Error",
      });
    }
  }
  return results;
}

/**
 * Aplica un ítem ML (por id MLA…) al producto vinculado en Aurix.
 * Usado por webhooks de notificaciones topic=items.
 */
export async function syncLinkedProductFromMeliItem(
  externalId: string
): Promise<{
  ok: boolean;
  skipped?: boolean;
  productId?: string;
  message: string;
}> {
  const itemId = externalId.trim().toUpperCase();
  if (!itemId) {
    return { ok: false, skipped: true, message: "Sin id de ítem." };
  }

  const cfg = await getConfigRow("mercadolibre");
  if (!cfg?.access_token) {
    return {
      ok: false,
      message: "Mercado Libre sin access token.",
    };
  }

  const links = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links
     WHERE channel = 'mercadolibre' AND external_id = ? LIMIT 1`,
    [itemId]
  );
  const link = links[0];
  if (!link) {
    return {
      ok: true,
      skipped: true,
      message: `Sin producto vinculado a ${itemId} (ignorado).`,
    };
  }

  const { getProduct, upsertProduct } = await import("./products.js");
  const product = await getProduct(link.product_id);
  if (!product) {
    return {
      ok: false,
      productId: link.product_id,
      message: "Producto vinculado no encontrado.",
    };
  }

  const item = await meliRequest<MeliItem>(cfg, "GET", `/items/${itemId}`);
  const status = String(item.status ?? "").toLowerCase();
  const price = Math.max(0, Number(item.price) || 0);
  const stock = Math.max(0, Math.floor(Number(item.available_quantity) || 0));
  const activo = status === "active";
  const nombre = String(item.title ?? "").trim() || product.nombre;

  let priceListId = cfg.price_list_id || "";
  if (!priceListId) {
    const { getDefaultComercioId } = await import("./comercios.js");
    const comercioId = product.comercioId || (await getDefaultComercioId());
    const ensured = await ensureMercadoLibrePriceList(comercioId);
    priceListId = ensured.id;
    await execute(
      `UPDATE channel_configs SET price_list_id = ? WHERE channel = 'mercadolibre'`,
      [priceListId]
    );
  }

  await upsertProduct({
    id: product.id,
    comercioId: product.comercioId ?? undefined,
    sku: product.sku,
    nombre,
    categoria: product.categoria,
    costo: product.costo,
    stock,
    activo,
    descripcion: product.descripcion,
    precios: {
      ...(product.precios ?? {}),
      [priceListId]: price || product.precios[priceListId] || product.precio || 0,
    },
  });

  await touchLink(product.id, "mercadolibre", null);

  return {
    ok: true,
    productId: product.id,
    message: `Actualizado ${product.sku}: stock ${stock}, precio ${price}, activo=${activo}.`,
  };
}

export async function enrichProductsWithLinks(
  products: Product[]
): Promise<Product[]> {
  if (!products.length) return products;
  const ids = products.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await query<LinkRow[]>(
    `SELECT * FROM product_channel_links WHERE product_id IN (${placeholders})`,
    ids
  );
  const byProduct = new Map<string, ChannelLink[]>();
  for (const row of rows) {
    const bag = byProduct.get(row.product_id) ?? [];
    bag.push(mapLink(row));
    byProduct.set(row.product_id, bag);
  }
  return products.map((p) => ({
    ...p,
    channelLinks: byProduct.get(p.id) ?? [],
  }));
}
