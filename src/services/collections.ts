import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import sharp from "sharp";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getDefaultPriceListId } from "./price-lists.js";

const PRICE = "COALESCE(pp.precio, p.precio_default)";
const JOINS = `LEFT JOIN categories cat ON cat.comercio_id = p.comercio_id AND cat.codigo = p.categoria
 LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = ?`;
const VISIBLE = `p.comercio_id = ? AND p.activo = 1 AND p.stock > 0 AND ${PRICE} > 0 AND (cat.id IS NULL OR cat.activa = 1)`;
export type CollectionDraft = {
  title: string;
  focalX: number;
  focalY: number;
  position: number;
  productIds: string[];
  imageDataUrl?: string | null;
  baseRevision: number;
  action: "draft" | "publish";
};
type CollectionRow = RowDataPacket & {
  id: string;
  title: string;
  focal_x: number;
  focal_y: number;
  position: number;
  revision: number;
  published_revision: number | null;
  published_title: string | null;
  has_image: number;
  active: number;
  image_version: string | null;
  product_count: number;
};
const META = `cc.id, cc.title, cc.focal_x, cc.focal_y, cc.position, cc.revision, cc.published_revision, cc.published_title, cc.active,
 (cc.image IS NOT NULL) AS has_image, cc.image_version,
 (SELECT COUNT(*) FROM catalog_collection_items ci WHERE ci.collection_id = cc.id AND ci.stage = 'draft') AS product_count`;
function draftMeta(row: CollectionRow, cid: string) {
  return {
    id: row.id,
    title: row.title,
    focalX: Number(row.focal_x),
    focalY: Number(row.focal_y),
    position: Number(row.position),
    revision: Number(row.revision),
    publishedRevision:
      row.published_revision === null ? null : Number(row.published_revision),
    publishedTitle: row.published_title,
    active: Boolean(row.active),
    productCount: Number(row.product_count),
    hasUnpublishedChanges:
      row.published_revision === null ||
      Number(row.revision) !== Number(row.published_revision),
    imageUrl: row.has_image
      ? `/aurix-api/api/catalog/collections/${encodeURIComponent(row.id)}/image?comercioId=${encodeURIComponent(cid)}&v=${encodeURIComponent(row.image_version ?? "")}`
      : null,
  };
}
export async function listCollections(cid: string) {
  const rows = await query<CollectionRow[]>(
    `SELECT ${META} FROM catalog_collections cc WHERE cc.comercio_id = ? ORDER BY cc.position, cc.created_at, cc.id LIMIT 50`,
    [cid],
  );
  return rows.map((row) => draftMeta(row, cid));
}
export async function getCollection(cid: string, id: string) {
  const rows = await query<CollectionRow[]>(
    `SELECT ${META} FROM catalog_collections cc WHERE cc.id = ? AND cc.comercio_id = ? LIMIT 1`,
    [id, cid],
  );
  if (!rows[0]) throw new HttpError(404, "La colección no está disponible.");
  const items = await query<(RowDataPacket & { product_id: string })[]>(
    "SELECT product_id FROM catalog_collection_items WHERE collection_id = ? AND stage = 'draft' ORDER BY position, product_id",
    [id],
  );
  return {
    ...draftMeta(rows[0], cid),
    productIds: items.map((item) => item.product_id),
  };
}
async function encodeCover(dataUrl: string) {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl,
  );
  if (!match) throw new HttpError(400, "Usá una portada JPG, PNG o WebP.");
  try {
    const image = sharp(Buffer.from(match[1], "base64"), {
      limitInputPixels: 24_000_000,
      failOn: "error",
    });
    const meta = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format ?? ""))
      throw new Error("Unsupported image");
    return {
      full: await image
        .clone()
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer(),
      small: await image
        .clone()
        .rotate()
        .resize(640, 640, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
    };
  } catch {
    throw new HttpError(
      400,
      "No pudimos leer la portada. Elegí otra imagen JPG, PNG o WebP.",
    );
  }
}
async function lockCollection(
  conn: PoolConnection,
  cid: string,
  id: string,
  revision: number,
) {
  const [rows] = await conn.execute<CollectionRow[]>(
    `SELECT id, title, revision, (image IS NOT NULL) AS has_image FROM catalog_collections WHERE id = ? AND comercio_id = ? FOR UPDATE`,
    [id, cid],
  );
  if (!rows[0]) throw new HttpError(404, "La colección no está disponible.");
  if (Number(rows[0].revision) !== revision)
    throw new HttpError(
      409,
      "Otra persona modificó esta colección. Cerrá y volvé a abrirla para cargar la última versión.",
    );
  return rows[0];
}
async function activate(
  conn: PoolConnection,
  cid: string,
  id: string,
  listId: string,
) {
  const [rows] = await conn.execute<CollectionRow[]>(
    "SELECT title, (image IS NOT NULL) AS has_image FROM catalog_collections WHERE id = ? AND comercio_id = ?",
    [id, cid],
  );
  if (!rows[0]?.title.trim() || !rows[0].has_image)
    throw new HttpError(400, "Para activar, agregá un título y una portada.");
  const [available] = await conn.execute<RowDataPacket[]>(
    `SELECT p.id FROM catalog_collection_items ci INNER JOIN products p ON p.id = ci.product_id
    ${JOINS} WHERE ci.collection_id = ? AND ci.stage = 'draft' AND ${VISIBLE} LIMIT 1`,
    [listId, id, cid],
  );
  if (!available.length)
    throw new HttpError(
      400,
      "Seleccioná al menos un producto activo, con stock y precio público, para activar la colección.",
    );
  await conn.execute(
    "DELETE FROM catalog_collection_items WHERE collection_id = ? AND stage = 'published'",
    [id],
  );
  await conn.execute(
    `INSERT INTO catalog_collection_items (collection_id, stage, product_id, position)
    SELECT collection_id, 'published', product_id, position FROM catalog_collection_items WHERE collection_id = ? AND stage = 'draft'`,
    [id],
  );
  await conn.execute(
    `UPDATE catalog_collections SET published_title = title, published_image = image, published_image_small = image_small, published_image_version = image_version,
    published_focal_x = focal_x, published_focal_y = focal_y, published_position = position, published_revision = revision, active = 1 WHERE id = ? AND comercio_id = ?`,
    [id, cid],
  );
}
export async function saveCollection(
  cid: string,
  id: string | undefined,
  input: CollectionDraft,
) {
  const image =
    input.imageDataUrl === undefined
      ? undefined
      : input.imageDataUrl === null
        ? null
        : await encodeCover(input.imageDataUrl);
  const listId =
    input.action === "publish" ? await getDefaultPriceListId(cid) : "";
  const collectionId = id ?? randomUUID();
  await withTransaction(async (conn) => {
    if (id) await lockCollection(conn, cid, id, input.baseRevision);
    else {
      if (input.baseRevision !== 0)
        throw new HttpError(409, "La versión del borrador no es válida.");
      await conn.execute("SELECT id FROM comercios WHERE id = ? FOR UPDATE", [
        cid,
      ]);
      const [count] = await conn.execute<(RowDataPacket & { n: number })[]>(
        "SELECT COUNT(*) AS n FROM catalog_collections WHERE comercio_id = ?",
        [cid],
      );
      if (Number(count[0].n) >= 50)
        throw new HttpError(
          400,
          "Podés crear hasta 50 colecciones. Reutilizá un borrador existente.",
        );
      await conn.execute(
        "INSERT INTO catalog_collections (id, comercio_id) VALUES (?, ?)",
        [collectionId, cid],
      );
    }
    if (input.productIds.length) {
      const [products] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM products WHERE comercio_id = ? AND id IN (${input.productIds.map(() => "?").join(",")})`,
        [cid, ...input.productIds],
      );
      if (products.length !== input.productIds.length)
        throw new HttpError(
          400,
          "La selección incluye productos que ya no existen o pertenecen a otro comercio.",
        );
    }
    await conn.execute(
      `UPDATE catalog_collections SET title = ?, focal_x = ?, focal_y = ?, position = ?, revision = revision + 1 WHERE id = ? AND comercio_id = ?`,
      [
        input.title,
        input.focalX,
        input.focalY,
        input.position,
        collectionId,
        cid,
      ],
    );
    if (image !== undefined)
      await conn.execute(
        "UPDATE catalog_collections SET image = ?, image_small = ?, image_version = ? WHERE id = ? AND comercio_id = ?",
        [
          image?.full ?? null,
          image?.small ?? null,
          image ? randomUUID() : null,
          collectionId,
          cid,
        ],
      );
    await conn.execute(
      "DELETE FROM catalog_collection_items WHERE collection_id = ? AND stage = 'draft'",
      [collectionId],
    );
    // Batch inserts keep large selections bounded without one round trip per product.
    for (let offset = 0; offset < input.productIds.length; offset += 200) {
      const batch = input.productIds.slice(offset, offset + 200);
      await conn.execute(
        `INSERT INTO catalog_collection_items (collection_id, stage, product_id, position) VALUES ${batch.map(() => "(?, 'draft', ?, ?)").join(",")}`,
        batch.flatMap((productId, index) => [
          collectionId,
          productId,
          offset + index,
        ]),
      );
    }
    if (input.action === "publish")
      await activate(conn, cid, collectionId, listId);
  });
  return getCollection(cid, collectionId);
}
export async function publishCollection(
  cid: string,
  id: string,
  revision: number,
) {
  const listId = await getDefaultPriceListId(cid);
  await withTransaction(async (conn) => {
    await lockCollection(conn, cid, id, revision);
    await activate(conn, cid, id, listId);
  });
  return getCollection(cid, id);
}
export async function pauseCollection(
  cid: string,
  id: string,
  revision: number,
) {
  await withTransaction(async (conn) => {
    await lockCollection(conn, cid, id, revision);
    await conn.execute(
      "UPDATE catalog_collections SET active = 0 WHERE id = ? AND comercio_id = ?",
      [id, cid],
    );
  });
  return getCollection(cid, id);
}
export async function collectionImage(
  cid: string,
  id: string,
  published: boolean,
  version?: string,
  small = false,
) {
  const listId = published ? await getDefaultPriceListId(cid) : "";
  const params: (string | number)[] = [id, cid];
  let condition = "";
  if (published) {
    condition = `AND cc.active = 1 AND EXISTS (SELECT 1 FROM catalog_collection_items ci INNER JOIN products p ON p.id = ci.product_id
      ${JOINS} WHERE ci.collection_id = cc.id AND ci.stage = 'published' AND ${VISIBLE})`;
    params.push(listId, cid);
  }
  if (version) {
    condition += ` AND cc.${published ? "published_image_version" : "image_version"} = ?`;
    params.push(version);
  }
  const rows = await query<(RowDataPacket & { image: Buffer | null })[]>(
    `SELECT cc.${published ? (small ? "published_image_small" : "published_image") : "image"} AS image FROM catalog_collections cc WHERE cc.id = ? AND cc.comercio_id = ? ${condition} LIMIT 1`,
    params,
  );
  if (!rows[0]?.image) throw new HttpError(404, "Portada no disponible.");
  return rows[0].image;
}
export async function publicCollections(cid: string, listId: string) {
  const rows = await query<
    (RowDataPacket & {
      id: string;
      title: string;
      version: string;
      focal_x: number;
      focal_y: number;
      count: number;
    })[]
  >(
    `SELECT cc.id, cc.published_title AS title, cc.published_image_version AS version,
    cc.published_focal_x AS focal_x, cc.published_focal_y AS focal_y, COUNT(*) AS count
    FROM catalog_collections cc INNER JOIN catalog_collection_items ci ON ci.collection_id = cc.id AND ci.stage = 'published'
    INNER JOIN products p ON p.id = ci.product_id ${JOINS}
    WHERE cc.comercio_id = ? AND cc.active = 1 AND cc.published_image IS NOT NULL AND ${VISIBLE}
    GROUP BY cc.id, cc.published_title, cc.published_image_version, cc.published_focal_x, cc.published_focal_y, cc.published_position, cc.created_at
    ORDER BY cc.published_position, cc.created_at, cc.id LIMIT 50`,
    [listId, cid, cid],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    focalX: Number(row.focal_x),
    focalY: Number(row.focal_y),
    count: Number(row.count),
    imageUrl: `/api/catalog/public/collections/${row.id}/image?${new URLSearchParams({ comercioId: cid, v: row.version })}`,
  }));
}
export async function pickerProducts(
  cid: string,
  options: { page: number; q: string; ids?: string[] },
) {
  const listId = await getDefaultPriceListId(cid);
  const params: (string | number)[] = [listId, cid];
  let where = "p.comercio_id = ?";
  if (options.ids) {
    if (!options.ids.length)
      return { items: [], page: options.page, hasMore: false };
    where += ` AND p.id IN (${options.ids.map(() => "?").join(",")})`;
    params.push(...options.ids);
  }
  if (options.q) {
    where += " AND (p.nombre LIKE ? ESCAPE '!' OR p.sku LIKE ? ESCAPE '!')";
    const term = `%${options.q.replace(/[!%_]/g, "!$&")}%`;
    params.push(term, term);
  }
  const rows = await query<
    (RowDataPacket & {
      id: string;
      name: string;
      sku: string;
      price: number;
      stock: number;
      available: number;
      image_id: string | null;
    })[]
  >(
    `SELECT p.id, p.nombre AS name, p.sku, ${PRICE} AS price, p.stock,
    (p.activo = 1 AND p.stock > 0 AND ${PRICE} > 0 AND (cat.id IS NULL OR cat.activa = 1)) AS available,
    (SELECT m.id FROM media_assets m WHERE m.product_id = p.id AND m.kind = 'image' AND m.mime LIKE 'image/%' ORDER BY m.is_primary DESC, m.sort_order, m.uploaded_at, m.id LIMIT 1) AS image_id
    FROM products p ${JOINS} WHERE ${where} ORDER BY p.nombre, p.id LIMIT 25 OFFSET ${(options.page - 1) * 24}`,
    params,
  );
  return {
    items: rows
      .slice(0, 24)
      .map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        unitPrice: Number(row.price),
        stock: Number(row.stock),
        available: Boolean(row.available),
        imageUrl: row.image_id
          ? `/api/media/${encodeURIComponent(row.image_id)}/content?thumbnail=1`
          : null,
      })),
    page: options.page,
    hasMore: rows.length > 24,
  };
}
export async function pickerIds(cid: string, q: string) {
  const params: string[] = [cid];
  let where = "comercio_id = ?";
  if (q) {
    where += " AND (nombre LIKE ? ESCAPE '!' OR sku LIKE ? ESCAPE '!')";
    const term = `%${q.replace(/[!%_]/g, "!$&")}%`;
    params.push(term, term);
  }
  const rows = await query<(RowDataPacket & { id: string })[]>(
    `SELECT id FROM products WHERE ${where} ORDER BY nombre, id LIMIT 2001`,
    params,
  );
  if (rows.length > 2000)
    throw new HttpError(
      400,
      "Hay más de 2000 resultados. Afiná la búsqueda para seleccionar un grupo menor.",
    );
  return rows.map((row) => row.id);
}
