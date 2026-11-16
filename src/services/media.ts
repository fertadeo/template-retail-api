import sharp from "sharp";
import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type { ProductImage } from "../types.js";
import { getDefaultComercioId } from "./comercios.js";

export type MediaKind = "image" | "attachment";

export type MediaAsset = {
  id: string;
  kind: MediaKind;
  source: "product_image" | "product_attachment" | "library";
  sourceLabel: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  dataUrl: string | null;
  thumbnailUrl?: string | null;
  uploadedAt: string;
  title: string;
  subtitle: string;
  entityHref: string;
  productId: string | null;
  comercioId: string | null;
  isPrimary: boolean;
  sortOrder: number;
};

export type MediaLibraryCounts = {
  images: number;
  attachments: number;
  total: number;
  totalSizeBytes: number;
  unknownSizeCount: number;
};

type MediaRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  product_id: string | null;
  is_primary: number | null;
  sort_order: number | null;
  kind: MediaKind;
  filename: string;
  mime: string;
  size_bytes: number;
  data_url: string | null;
  source_url: string | null;
  title: string;
  uploaded_at: string | Date;
  product_nombre: string | null;
  product_sku: string | null;
};

function dateStr(v: string | Date): string {
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

function kindFromMime(mime: string, forced?: MediaKind): MediaKind {
  if (forced) return forced;
  return mime.trim().toLowerCase().startsWith("image/")
    ? "image"
    : "attachment";
}

function mapRow(row: MediaRow): MediaAsset {
  const kind = row.kind;
  const productName = row.product_nombre?.trim() || null;
  const sku = row.product_sku?.trim() || null;
  const source =
    kind === "image"
      ? productName
        ? "product_image"
        : "library"
      : productName
        ? "product_attachment"
        : "library";
  const sourceLabel =
    source === "product_image"
      ? row.is_primary
        ? "Imagen principal"
        : "Imagen secundaria"
      : source === "product_attachment"
        ? "Adjunto de producto"
        : kind === "image"
          ? "Imagen de biblioteca"
          : "Archivo de biblioteca";

  return {
    id: row.id,
    kind,
    source,
    sourceLabel,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes) || 0,
    dataUrl: row.data_url || row.source_url || null,
    uploadedAt: dateStr(row.uploaded_at),
    title: row.title?.trim() || productName || row.filename,
    subtitle: [sku ? `SKU ${sku}` : "", productName || ""]
      .filter(Boolean)
      .join(" · "),
    entityHref: row.product_id ? "/productos" : "/biblioteca",
    productId: row.product_id,
    comercioId: row.comercio_id,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order) || 0,
  };
}

function toProductImage(row: MediaRow): ProductImage {
  const dataUrl = row.data_url?.trim() || null;
  const sourceUrl = row.source_url?.trim() || null;
  const url = dataUrl || sourceUrl;
  return {
    id: row.id,
    url,
    dataUrl: url,
    sourceUrl,
    title: row.title?.trim() || row.filename,
    filename: row.filename,
    mime: row.mime || "image/jpeg",
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order) || 0,
  };
}

async function clearPrimary(productId: string, exceptId?: string) {
  if (exceptId) {
    await execute(
      `UPDATE media_assets
       SET is_primary = 0
       WHERE product_id = ? AND kind = 'image' AND id <> ?`,
      [productId, exceptId]
    );
  } else {
    await execute(
      `UPDATE media_assets
       SET is_primary = 0
       WHERE product_id = ? AND kind = 'image'`,
      [productId]
    );
  }
}

async function ensurePrimary(productId: string) {
  const primaries = await query<RowDataPacket[]>(
    `SELECT id FROM media_assets
     WHERE product_id = ? AND kind = 'image' AND is_primary = 1
     LIMIT 1`,
    [productId]
  );
  if (primaries[0]) return;
  const first = await query<RowDataPacket[]>(
    `SELECT id FROM media_assets
     WHERE product_id = ? AND kind = 'image'
     ORDER BY sort_order ASC, uploaded_at ASC, id ASC
     LIMIT 1`,
    [productId]
  );
  if (first[0]) {
    await execute(`UPDATE media_assets SET is_primary = 1 WHERE id = ?`, [
      first[0].id,
    ]);
  }
}

async function nextSortOrder(productId: string): Promise<number> {
  const rows = await query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_ord
     FROM media_assets
     WHERE product_id = ? AND kind = 'image'`,
    [productId]
  );
  return Number(rows[0]?.next_ord) || 0;
}

const MEDIA_COLUMNS = `m.id, m.comercio_id, m.product_id, m.is_primary, m.sort_order,
  m.kind, m.filename, m.mime, m.size_bytes, m.title, m.uploaded_at,
  m.source_url, NULL AS data_url`;

function mediaUrl(id: string, thumbnail = false): string {
  return `/api/media/${encodeURIComponent(id)}/content${thumbnail ? "?thumbnail=1" : ""}`;
}

function mapListedMedia(row: MediaRow): MediaAsset {
  const item = mapRow(row);
  return {
    ...item,
    dataUrl: row.source_url || mediaUrl(row.id),
    thumbnailUrl: row.kind === "image" ? row.source_url || mediaUrl(row.id, true) : null,
  };
}

/** Metadata only: never select LONGTEXT data_url for a library listing. */
export async function listMediaPage(opts: {
  comercioId: string; kind: MediaKind | "all"; q: string;
  productId?: string; page: number; pageSize: number;
}) {
  const where = ["(m.comercio_id = ? OR m.comercio_id IS NULL)"];
  const params: (string | number)[] = [opts.comercioId];
  if (opts.productId) { where.push("m.product_id = ?"); params.push(opts.productId); }
  if (opts.q) {
    const term = `%${opts.q.replace(/[!%_]/g, "!$&")}%`;
    where.push("(m.filename LIKE ? ESCAPE '!' OR m.title LIKE ? ESCAPE '!' OR p.nombre LIKE ? ESCAPE '!' OR p.sku LIKE ? ESCAPE '!')");
    params.push(term, term, term, term);
  }
  const from = `FROM media_assets m LEFT JOIN products p ON p.id = m.product_id`;
  const baseWhere = where.join(" AND ");
  const countParams = [...params];
  if (opts.kind !== "all") { where.push("m.kind = ?"); params.push(opts.kind); }
  const [rows, groups] = await Promise.all([
    query<MediaRow[]>(`SELECT ${MEDIA_COLUMNS}, p.nombre AS product_nombre, p.sku AS product_sku
      ${from} WHERE ${where.join(" AND ")}
      ORDER BY m.uploaded_at DESC, m.id DESC
      LIMIT ${opts.pageSize + 1} OFFSET ${(opts.page - 1) * opts.pageSize}`, params),
    query<(RowDataPacket & { kind: MediaKind; count: number; bytes: string | number; unknown_size: string | number })[]>(
      `SELECT m.kind, COUNT(*) AS count,
        COALESCE(SUM(GREATEST(COALESCE(m.size_bytes, 0), 0)), 0) AS bytes,
        SUM(CASE WHEN COALESCE(m.size_bytes, 0) <= 0 THEN 1 ELSE 0 END) AS unknown_size ${from} WHERE ${baseWhere} GROUP BY m.kind`, countParams),
  ]);
  const counts: MediaLibraryCounts = { images: 0, attachments: 0, total: 0, totalSizeBytes: 0, unknownSizeCount: 0 };
  for (const group of groups) {
    const count = Number(group.count);
    if (group.kind === "image") counts.images = count; else counts.attachments = count;
    counts.total += count;
    counts.totalSizeBytes += Number(group.bytes) || 0;
    counts.unknownSizeCount += Number(group.unknown_size) || 0;
  }
  return { items: rows.slice(0, opts.pageSize).map(mapListedMedia), counts,
    page: opts.page, pageSize: opts.pageSize, hasMore: rows.length > opts.pageSize };
}

/** Fetch one result after mutations instead of re-reading the library. */
async function getListedMedia(id: string): Promise<MediaAsset> {
  const rows = await query<MediaRow[]>(`SELECT ${MEDIA_COLUMNS}, p.nombre AS product_nombre, p.sku AS product_sku
    FROM media_assets m LEFT JOIN products p ON p.id = m.product_id WHERE m.id = ? LIMIT 1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Medio no encontrado.");
  return mapListedMedia(rows[0]);
}

// Bounded thumbnail cache, keyed by source content so updates cannot serve old images.
const thumbnails = new Map<string, Buffer>();
let thumbnailBytes = 0;
const THUMBNAIL_BUDGET = 32 * 1024 * 1024;
export async function getMediaContent(id: string, thumbnail: boolean): Promise<
  { redirect: string } | { body: Buffer; mime: string; filename: string }
> {
  const rows = await query<MediaRow[]>(`SELECT mime, filename, data_url, source_url FROM media_assets WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) throw new HttpError(404, "Medio no encontrado.");
  if (row.source_url && !row.data_url) return { redirect: row.source_url };
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(row.data_url ?? "");
  if (!match) throw new HttpError(404, "Archivo no disponible.");
  let body: Buffer;
  try { body = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])); }
  catch { throw new HttpError(400, "Archivo inválido."); }
  let mime = row.mime;
  if (thumbnail && mime.startsWith("image/") && mime !== "image/svg+xml") {
    const key = createHash("sha256").update(body).digest("hex");
    let cached = thumbnails.get(key);
    if (!cached) {
      try {
        cached = await sharp(body, { limitInputPixels: 40_000_000 })
          .rotate().resize(480, 360, { fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      } catch { cached = undefined; } // Unsupported images retain their original representation.
      if (cached && cached.length <= THUMBNAIL_BUDGET) {
        while (thumbnailBytes + cached.length > THUMBNAIL_BUDGET && thumbnails.size) {
          const oldest = thumbnails.keys().next().value!;
          thumbnailBytes -= thumbnails.get(oldest)!.length;
          thumbnails.delete(oldest);
        }
        thumbnails.set(key, cached); thumbnailBytes += cached.length;
      }
    }
    if (cached) { body = cached; mime = "image/webp"; }
  }
  return { body, mime, filename: row.filename };
}

export async function listProductImages(
  productId: string
): Promise<ProductImage[]> {
  const rows = await query<MediaRow[]>(
    `SELECT m.*, NULL AS product_nombre, NULL AS product_sku
     FROM media_assets m
     WHERE m.product_id = ? AND m.kind = 'image'
     ORDER BY m.is_primary DESC, m.sort_order ASC, m.uploaded_at ASC, m.id ASC`,
    [productId]
  );
  return rows.map(toProductImage);
}

/** Carga imágenes de varios productos. primaryOnly=true → solo la principal. */
export async function loadImagesForProducts(
  productIds: string[],
  opts?: { primaryOnly?: boolean }
): Promise<Map<string, ProductImage[]>> {
  const map = new Map<string, ProductImage[]>();
  if (!productIds.length) return map;
  const placeholders = productIds.map(() => "?").join(",");
  const primaryFilter = opts?.primaryOnly ? " AND m.is_primary = 1" : "";
  // En listados: preferir source_url y no arrastrar LONGTEXT base64 si hay URL remota.
  const rows = await query<MediaRow[]>(
    `SELECT
       m.id, m.comercio_id, m.product_id, m.is_primary, m.sort_order,
       m.kind, m.filename, m.mime, m.size_bytes, m.title, m.uploaded_at,
       m.source_url,
       ${opts?.primaryOnly ? "NULL" : "CASE WHEN m.source_url IS NOT NULL AND TRIM(m.source_url) <> '' THEN NULL ELSE m.data_url END"} AS data_url,
       NULL AS product_nombre,
       NULL AS product_sku
     FROM media_assets m
     WHERE m.product_id IN (${placeholders})
       AND m.kind = 'image'${primaryFilter}
     ORDER BY m.is_primary DESC, m.sort_order ASC, m.uploaded_at ASC, m.id ASC`,
    productIds
  );
  for (const row of rows) {
    if (!row.product_id) continue;
    const bag = map.get(row.product_id) ?? [];
    bag.push(opts?.primaryOnly ? {
      ...toProductImage(row), url: row.source_url || mediaUrl(row.id, true),
      dataUrl: null,
    } : toProductImage(row));
    map.set(row.product_id, bag);
  }
  return map;
}

export function splitProductImages(images: ProductImage[]): {
  imagenPrincipal: ProductImage | null;
  imagenesSecundarias: ProductImage[];
} {
  const primary = images.find((i) => i.isPrimary) ?? images[0] ?? null;
  const secundarias = images.filter((i) => i.id !== primary?.id);
  return {
    imagenPrincipal: primary
      ? { ...primary, isPrimary: true }
      : null,
    imagenesSecundarias: secundarias.map((i) => ({
      ...i,
      isPrimary: false,
    })),
  };
}

export async function createMedia(input: {
  comercioId?: string;
  productId?: string | null;
  kind?: MediaKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  dataUrl: string | null;
  sourceUrl?: string | null;
  title?: string;
  isPrimary?: boolean;
  sortOrder?: number;
}): Promise<MediaAsset> {
  const filename = input.filename?.trim();
  if (!filename) throw new HttpError(400, "El nombre de archivo es obligatorio.");
  const mime = input.mime?.trim() || "application/octet-stream";
  const kind = kindFromMime(mime, input.kind);
  const comercioId =
    input.comercioId || (await getDefaultComercioId());
  const id = nextId("media");
  const uploadedAt = new Date().toISOString().slice(0, 10);
  const title = input.title?.trim() || filename;
  const productId = input.productId?.trim() || null;
  const sourceUrl = input.sourceUrl?.trim() || null;
  const dataUrl = input.dataUrl ?? null;
  if (!dataUrl && !sourceUrl) {
    throw new HttpError(400, "Se requiere dataUrl o sourceUrl.");
  }

  if (productId) {
    const exists = await query<RowDataPacket[]>(
      `SELECT id FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );
    if (!exists[0]) throw new HttpError(400, "Producto no encontrado.");
  }

  let isPrimary = 0;
  let sortOrder = Math.max(0, Number(input.sortOrder) || 0);
  if (productId && kind === "image") {
    sortOrder =
      input.sortOrder != null
        ? Math.max(0, Number(input.sortOrder) || 0)
        : await nextSortOrder(productId);
    const existing = await query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM media_assets
       WHERE product_id = ? AND kind = 'image'`,
      [productId]
    );
    const count = Number(existing[0]?.n) || 0;
    const wantPrimary = input.isPrimary === true || count === 0;
    if (wantPrimary) {
      await clearPrimary(productId);
      isPrimary = 1;
    }
  }

  await execute(
    `INSERT INTO media_assets (
      id, comercio_id, product_id, is_primary, sort_order, kind, filename, mime,
      size_bytes, data_url, source_url, title, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      comercioId,
      productId,
      isPrimary,
      sortOrder,
      kind,
      filename,
      mime,
      Math.max(0, Number(input.sizeBytes) || 0),
      dataUrl,
      sourceUrl,
      title,
      uploadedAt,
    ]
  );

  return getListedMedia(id);
}

export async function updateMedia(
  id: string,
  input: {
    productId?: string | null;
    title?: string;
    isPrimary?: boolean;
    sortOrder?: number;
  }
): Promise<MediaAsset> {
  const rows = await query<MediaRow[]>(
    `SELECT ${MEDIA_COLUMNS}, p.nombre AS product_nombre, p.sku AS product_sku
     FROM media_assets m
     LEFT JOIN products p ON p.id = m.product_id
     WHERE m.id = ?
     LIMIT 1`,
    [id]
  );
  const current = rows[0];
  if (!current) throw new HttpError(404, "Medio no encontrado.");

  let productId =
    input.productId === undefined
      ? current.product_id
      : input.productId?.trim() || null;
  const title =
    input.title === undefined
      ? current.title
      : input.title.trim() || current.filename;
  let sortOrder =
    input.sortOrder === undefined
      ? Number(current.sort_order) || 0
      : Math.max(0, Number(input.sortOrder) || 0);
  let isPrimary = Boolean(current.is_primary);

  if (productId) {
    const exists = await query<RowDataPacket[]>(
      `SELECT id FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );
    if (!exists[0]) throw new HttpError(400, "Producto no encontrado.");
  }

  if (current.kind === "image" && productId) {
    if (input.isPrimary === true) {
      await clearPrimary(productId, id);
      isPrimary = true;
    } else if (input.isPrimary === false) {
      isPrimary = false;
    }
  } else if (!productId) {
    isPrimary = false;
  }

  await execute(
    `UPDATE media_assets
     SET product_id = ?, title = ?, is_primary = ?, sort_order = ?
     WHERE id = ?`,
    [productId, title, isPrimary ? 1 : 0, sortOrder, id]
  );

  if (current.product_id && current.product_id !== productId) {
    await ensurePrimary(current.product_id);
  }
  if (productId && current.kind === "image") {
    await ensurePrimary(productId);
  }

  return getListedMedia(id);
}

export async function setProductImagePrimary(
  productId: string,
  mediaId: string
): Promise<ProductImage[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT id, kind FROM media_assets
     WHERE id = ? AND product_id = ?
     LIMIT 1`,
    [mediaId, productId]
  );
  if (!rows[0]) throw new HttpError(404, "Imagen no encontrada en el producto.");
  if (rows[0].kind !== "image") {
    throw new HttpError(400, "Solo se puede marcar como principal una imagen.");
  }
  await clearPrimary(productId);
  await execute(`UPDATE media_assets SET is_primary = 1 WHERE id = ?`, [
    mediaId,
  ]);
  return listProductImages(productId);
}

export async function deleteMedia(id: string): Promise<void> {
  const rows = await query<RowDataPacket[]>(
    `SELECT product_id, kind FROM media_assets WHERE id = ? LIMIT 1`,
    [id]
  );
  const result = await execute(`DELETE FROM media_assets WHERE id = ?`, [id]);
  if (result.affectedRows === 0) {
    throw new HttpError(404, "Medio no encontrado.");
  }
  const productId = rows[0]?.product_id as string | null;
  if (productId && rows[0]?.kind === "image") {
    await ensurePrimary(productId);
  }
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop() || "";
    const clean = decodeURIComponent(base).split("?")[0];
    if (clean && /\.[a-z0-9]{2,5}$/i.test(clean)) return clean.slice(0, 180);
  } catch {
    /* ignore */
  }
  return fallback;
}

function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

/**
 * Sincroniza galería remota (WooCommerce) en un producto.
 * Reemplaza solo imágenes con source_url; conserva uploads locales (data_url).
 */
function normalizeRemoteImageSrc(raw: unknown): string | null {
  const src = String(raw ?? "").trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src.slice(0, 2048);
  // Protocol-relative (CDNs / sitios con http+https)
  if (src.startsWith("//")) return `https:${src}`.slice(0, 2048);
  return null;
}

export async function syncProductImagesFromUrls(
  productId: string,
  images: Array<{ src?: string; name?: string; alt?: string }>,
  opts?: { comercioId?: string; max?: number }
): Promise<number> {
  const max = Math.max(1, Math.min(opts?.max ?? 8, 12));
  const seen = new Set<string>();
  const urls: Array<{ src: string; title: string }> = [];
  for (const img of images) {
    const src = normalizeRemoteImageSrc(img.src);
    if (!src) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    urls.push({
      src,
      title: String(img.alt || img.name || "").trim() || filenameFromUrl(src, "imagen"),
    });
    if (urls.length >= max) break;
  }
  if (!urls.length) return 0;

  await execute(
    `DELETE FROM media_assets
     WHERE product_id = ? AND kind = 'image'
       AND source_url IS NOT NULL AND TRIM(source_url) <> ''`,
    [productId]
  );

  const remainingRows = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM media_assets
     WHERE product_id = ? AND kind = 'image'`,
    [productId]
  );
  const remaining = Number(remainingRows[0]?.n) || 0;
  let added = 0;
  for (let i = 0; i < urls.length; i++) {
    const { src, title } = urls[i];
    const filename = filenameFromUrl(src, `wc-${i + 1}.jpg`);
    await createMedia({
      comercioId: opts?.comercioId,
      productId,
      kind: "image",
      filename,
      mime: mimeFromFilename(filename),
      sizeBytes: 0,
      dataUrl: null,
      sourceUrl: src,
      title,
      isPrimary: remaining === 0 && i === 0,
      sortOrder: remaining + i,
    });
    added += 1;
  }
  return added;
}
