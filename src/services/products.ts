import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type { Product, ProductCategory } from "../types.js";
import {
  getProductsStockByBranch,
  setProductBranchStock,
} from "./branches.js";
import { enrichProductsWithLinks } from "./channels.js";
import {
  findShareGroupForComercio,
  getDefaultComercioId,
  setProductStock,
} from "./comercios.js";
import {
  loadImagesForProducts,
  splitProductImages,
} from "./media.js";
import { getDefaultPriceListId } from "./price-lists.js";

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

  // Batch: evita N+1 que saturaba el pool (Queue limit reached).
  const [imageMap, stockMap] = await Promise.all([
    imageMode === "none"
      ? Promise.resolve(new Map())
      : loadImagesForProducts(productIds, {
          primaryOnly: imageMode === "primary",
        }),
    getProductsStockByBranch(productIds),
  ]);

  const uniqueComercioIds = [
    ...new Set(
      products
        .map((p) => p.comercioId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const shareFlags = new Map<string, boolean>();
  await Promise.all(
    uniqueComercioIds.map(async (cid) => {
      const g = await findShareGroupForComercio(cid);
      shareFlags.set(cid, g?.modo === "shared");
    })
  );

  const withStock = products.map((p) => {
    const { imagenPrincipal, imagenesSecundarias } = splitProductImages(
      imageMap.get(p.id) ?? []
    );
    return {
      ...p,
      stockShared: p.comercioId
        ? (shareFlags.get(p.comercioId) ?? false)
        : false,
      stockByBranch: stockMap.get(p.id) ?? {},
      imagenPrincipal,
      imagenesSecundarias:
        imageMode === "primary" ? [] : imagenesSecundarias,
    };
  });
  return enrichProductsWithLinks(withStock);
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
  return decorate(base, { images: "primary" });
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
  const [enriched] = await decorate(
    [mapProduct(rows[0], precios.get(id) ?? {}, sold.get(id) ?? 0)],
    { images: "all" }
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
  const sku = input.sku.trim().toUpperCase();
  const nombre = input.nombre.trim();
  if (!sku || !nombre) {
    throw new HttpError(400, "SKU y nombre son obligatorios.");
  }
  const comercioId = input.comercioId || (await getDefaultComercioId());
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
          input.categoria,
          precioDefault,
          input.costo,
          input.stock,
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
          input.categoria,
          precioDefault,
          input.costo,
          input.stock,
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

  await setProductStock(id, input.stock);

  // Stock por sucursal solo si el cliente lo pide; el stock del comercio es products.stock.
  if (input.stockByBranch && Object.keys(input.stockByBranch).length > 0) {
    await setProductBranchStock(id, input.stockByBranch);
  }

  const product = await getProduct(id);
  if (!product) throw new HttpError(500, "No se pudo guardar el producto.");
  return product;
}
