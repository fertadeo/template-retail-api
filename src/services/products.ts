import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type { Product, ProductCategory, ProductImage } from "../types.js";
import { getDefaultComercioId } from "./comercios.js";
import {
  loadImagesForProducts,
  splitProductImages,
} from "./media.js";
import { getDefaultPriceListId } from "./price-lists.js";
import {
  assertCategoryCodigo,
  listCategories,
} from "./categories.js";

type ProdRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  sku: string;
  nombre: string;
  categoria: ProductCategory;
  precio_default: string | number;
  costo: string | number;
  stock: number;
  activo: number;
  descripcion: string;
  created_at?: Date | string;
};

type PriceRow = RowDataPacket & {
  product_id: string;
  price_list_id: string;
  precio: string | number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

async function loadPrecios(
  productIds: string[]
): Promise<Map<string, Record<string, number>>> {
  const map = new Map<string, Record<string, number>>();
  if (!productIds.length) return map;
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await query<PriceRow[]>(
    `SELECT product_id, price_list_id, precio
     FROM product_prices WHERE product_id IN (${placeholders})`,
    productIds
  );
  for (const row of rows) {
    const bag = map.get(row.product_id) ?? {};
    bag[row.price_list_id] = num(row.precio);
    map.set(row.product_id, bag);
  }
  return map;
}

function iso(v: Date | string | undefined): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s || undefined;
}

function mapProduct(
  row: ProdRow,
  precios: Record<string, number>,
  unitsSold = 0
): Product {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    sku: row.sku,
    nombre: row.nombre,
    categoria: row.categoria,
    precio: num(row.precio_default),
    precios,
    costo: num(row.costo),
    stock: row.stock,
    activo: Boolean(row.activo),
    descripcion: row.descripcion,
    createdAt: iso(row.created_at),
    unitsSold,
  };
}

async function loadUnitsSold(
  productIds: string[],
  comercioId: string
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!productIds.length) return map;
  const ph = productIds.map(() => "?").join(",");
  const rows = await query<
    (RowDataPacket & { product_id: string; units: number | string })[]
  >(
    `SELECT ol.product_id, COALESCE(SUM(ol.cantidad), 0) AS units
     FROM order_lines ol
     INNER JOIN orders o ON o.id = ol.order_id
     WHERE ol.product_id IN (${ph})
       AND o.comercio_id = ?
       AND o.status NOT IN ('cancelado', 'borrador')
     GROUP BY ol.product_id`,
    [...productIds, comercioId]
  );
  for (const row of rows) {
    map.set(row.product_id, Number(row.units) || 0);
  }
  return map;
}

async function decorate(
  products: Product[],
  opts?: { images?: "primary" | "all" | "none" }
): Promise<Product[]> {
  if (!products.length) return products;

  const imageMode = opts?.images ?? "all";
  const productIds = products.map((p) => p.id);

  const imageMap = imageMode === "none" ? new Map<string, ProductImage[]>() : await loadImagesForProducts(productIds, { primaryOnly: imageMode === "primary" });
  return products.map(p => {
    const { imagenPrincipal, imagenesSecundarias } = splitProductImages(imageMap.get(p.id) ?? []);
    return { ...p, imagenPrincipal, imagenesSecundarias: imageMode === "primary" ? [] : imagenesSecundarias };
  });
}

async function withCategoryNames(products: Product[]): Promise<Product[]> {
  if (!products.length) return products;
  const comercioIds = [
    ...new Set(
      products
        .map((p) => p.comercioId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const names = new Map<string, string>();
  await Promise.all(
    comercioIds.map(async (cid) => {
      const cats = await listCategories(false, cid);
      for (const cat of cats) names.set(`${cid}|${cat.codigo}`, cat.nombre);
    })
  );
  return products.map((p) => ({
    ...p,
    categoriaNombre: p.comercioId
      ? (names.get(`${p.comercioId}|${p.categoria}`) ?? null)
      : null,
  }));
}

export async function listProducts(comercioId?: string): Promise<Product[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const rows = await query<ProdRow[]>(
    `SELECT * FROM products WHERE comercio_id = ? ORDER BY nombre ASC`,
    [cid]
  );
  const ids = rows.map((r) => r.id);
  const [precios, sold] = await Promise.all([
    loadPrecios(ids),
    loadUnitsSold(ids, cid),
  ]);
  const base = rows.map((r) =>
    mapProduct(r, precios.get(r.id) ?? {}, sold.get(r.id) ?? 0)
  );
  return withCategoryNames(await decorate(base, { images: "primary" }));
}

export type ProductPageOptions = {
  page: number; pageSize: number; q: string; category: string;
  health: "all" | "ready" | "attention" | "critical";
  sort: "nombre" | "recent" | "oldest" | "sold_desc" | "sold_asc";
  pos: boolean;
};

// Health metadata is intentionally independent of the product page request.
const healthSql = `CASE WHEN (
  TRIM(p.sku) = '' OR TRIM(p.nombre) = '' OR p.precio_default <= 0 OR NOT EXISTS (
    SELECT 1 FROM media_assets m WHERE m.product_id = p.id AND m.kind = 'image' AND m.is_primary = 1
    AND (COALESCE(m.source_url, '') <> '' OR OCTET_LENGTH(m.data_url) > 0)
  )) THEN 'critical' WHEN (TRIM(p.descripcion) = '' OR p.stock <= 0 OR p.activo = 0)
  THEN 'attention' ELSE 'ready' END`;

export async function productHealthCounts(cid: string, q: string, category: string) {
  const where = ["p.comercio_id = ?"];
  const params = [cid];
  if (category) { where.push("p.categoria = ?"); params.push(category); }
  if (q) {
    const term = `%${q.replace(/[!%_]/g, "!$&")}%`;
    where.push("(p.sku LIKE ? ESCAPE '!' OR p.nombre LIKE ? ESCAPE '!')"); params.push(term, term);
  }
  const rows = await query<(RowDataPacket & { level: "ready" | "attention" | "critical"; count: number })[]>(
    `SELECT ${healthSql} AS level, COUNT(*) AS count FROM products p WHERE ${where.join(" AND ")} GROUP BY level`, params
  );
  const counts = { all: 0, ready: 0, attention: 0, critical: 0 };
  for (const row of rows) { counts[row.level] = Number(row.count); counts.all += Number(row.count); }
  return counts;
}

/** Filter and limit before loading prices, images and channel links. */
export async function listProductsPage(cid: string, opts: ProductPageOptions) {
  const where = ["p.comercio_id = ?"];
  const params: (string | number)[] = [cid];
  if (opts.pos) where.push("p.activo = 1", "p.stock > 0");
  if (opts.category) { where.push("p.categoria = ?"); params.push(opts.category); }
  if (opts.q) {
    // Scanners / pasted codes take the indexed equality path first.
    const exact = opts.pos ? await query<ProdRow[]>(
      `SELECT p.* FROM products p WHERE ${where.join(" AND ")} AND p.sku = ? LIMIT 1`,
      [...params, opts.q]
    ) : [];
    if (exact.length) {
      const prices = opts.page === 1 ? await loadPrecios([exact[0].id]) : new Map<string, Record<string, number>>();
      return {
        items: opts.page === 1 ? [mapProduct(exact[0], prices.get(exact[0].id) ?? {})] : [],
        page: opts.page, pageSize: opts.pageSize, hasMore: false,
        counts: { all: 0, ready: 0, attention: 0, critical: 0 },
      };
    } else {
      const term = opts.q.replace(/[!%_]/g, "!$&");
      where.push("(p.sku LIKE ? ESCAPE '!' OR p.nombre LIKE ? ESCAPE '!')");
      params.push(`%${term}%`, `%${term}%`);
    }
  }
  if (!opts.pos && opts.health !== "all") {
    where.push(`(${healthSql}) = ?`); params.push(opts.health);
  }
  const soldSort = opts.sort === "sold_desc" || opts.sort === "sold_asc";
  const soldJoin = soldSort ? `LEFT JOIN (
    SELECT ol.product_id, SUM(ol.cantidad) AS units FROM order_lines ol
    INNER JOIN orders o ON o.id = ol.order_id
    WHERE o.comercio_id = ? AND o.status NOT IN ('cancelado', 'borrador')
    GROUP BY ol.product_id
  ) sales ON sales.product_id = p.id` : "";
  const orders = {
    nombre: "p.nombre ASC", recent: "p.created_at DESC", oldest: "p.created_at ASC",
    sold_desc: "COALESCE(sales.units, 0) DESC", sold_asc: "COALESCE(sales.units, 0) ASC",
  };
  const offset = (opts.page - 1) * opts.pageSize;
  const rows = await query<ProdRow[]>(
    `SELECT p.* FROM products p ${soldJoin} WHERE ${where.join(" AND ")}
     ORDER BY ${orders[opts.sort]}, p.id ASC LIMIT ${opts.pageSize + 1} OFFSET ${offset}`,
    soldSort ? [cid, ...params] : params
  );
  const hasMore = rows.length > opts.pageSize;
  const selected = rows.slice(0, opts.pageSize);
  const ids = selected.map(r => r.id);
  const base = selected.map(r => mapProduct(r, {}));
  const [prices, sold, images, named] = await Promise.all([
    loadPrecios(ids),
    opts.pos ? Promise.resolve(new Map<string, number>()) : loadUnitsSold(ids, cid),
    opts.pos ? Promise.resolve(new Map<string, ProductImage[]>()) : loadImagesForProducts(ids, { primaryOnly: true }),
    opts.pos ? Promise.resolve(base) : withCategoryNames(base),
  ]);
  const items = base.map((p, index) => ({
    ...p, precios: prices.get(p.id) ?? {}, unitsSold: sold.get(p.id) ?? 0,
    categoriaNombre: named[index].categoriaNombre,
    imagenPrincipal: splitProductImages(images.get(p.id) ?? []).imagenPrincipal,
  }));
  return { items, page: opts.page, pageSize: opts.pageSize, hasMore };

}

export async function getProduct(id: string): Promise<Product | null> {
  const rows = await query<ProdRow[]>(
    `SELECT * FROM products WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  const cid = rows[0].comercio_id || (await getDefaultComercioId());
  const [precios, sold] = await Promise.all([
    loadPrecios([id]),
    loadUnitsSold([id], cid),
  ]);
  const [enriched] = await withCategoryNames(
    await decorate(
      [mapProduct(rows[0], precios.get(id) ?? {}, sold.get(id) ?? 0)],
      { images: "all" }
    )
  );
  return enriched ?? null;
}

export async function upsertProduct(input: {
  id?: string;
  comercioId?: string;
  sku: string;
  nombre: string;
  categoria: ProductCategory;
  costo: number;
  stock: number;
  stockByBranch?: Record<string, number>;
  activo?: boolean;
  descripcion?: string;
  precios: Record<string, number>;
}): Promise<Product> {
  const stock = Math.max(0, Math.floor(input.stock));
  const sku = input.sku.trim().toUpperCase();
  const nombre = input.nombre.trim();
  if (!sku || !nombre) {
    throw new HttpError(400, "SKU y nombre son obligatorios.");
  }
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const categoria = input.categoria.trim();
  let allowInactive = false;
  if (input.id) {
    const current = await query<(RowDataPacket & { categoria: string })[]>(
      `SELECT categoria FROM products WHERE id = ? LIMIT 1`,
      [input.id]
    );
    allowInactive = current[0]?.categoria === categoria;
  }
  await assertCategoryCodigo(comercioId, categoria, { allowInactive });
  const defaultListId = await getDefaultPriceListId(comercioId);
  const precioDefault =
    input.precios[defaultListId] ??
    Object.values(input.precios)[0] ??
    0;

  const id = input.id ?? nextId("p");

  await withTransaction(async (conn) => {
    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE products
         SET sku = ?, nombre = ?, categoria = ?, precio_default = ?,
             costo = ?, stock = ?, activo = ?, descripcion = ?, comercio_id = ?
         WHERE id = ?`,
        [
          sku,
          nombre,
          categoria,
          precioDefault,
          input.costo,
          stock,
          input.activo === false ? 0 : 1,
          input.descripcion?.trim() ?? "",
          comercioId,
          id,
        ]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Producto no encontrado.");
      }
      await conn.execute(`DELETE FROM product_prices WHERE product_id = ?`, [
        id,
      ]);
    } else {
      await conn.execute(
        `INSERT INTO products
         (id, comercio_id, sku, nombre, categoria, precio_default, costo, stock, activo, descripcion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          comercioId,
          sku,
          nombre,
          categoria,
          precioDefault,
          input.costo,
          stock,
          input.activo === false ? 0 : 1,
          input.descripcion?.trim() ?? "",
        ]
      );
    }

    for (const [listId, precio] of Object.entries(input.precios)) {
      await conn.execute(
        `INSERT INTO product_prices (product_id, price_list_id, precio)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE precio = VALUES(precio)`,
        [id, listId, precio]
      );
    }
  });


  const product = await getProduct(id);
  if (!product) throw new HttpError(500, "No se pudo guardar el producto.");
  return product;
}
