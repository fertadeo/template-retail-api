const { test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../dist/db/pool.js");
const priceLists = require("../dist/services/price-lists.js");
priceLists.getDefaultPriceListId = async (cid) => `list-${cid}`;
let row = {
  id: "c1",
  cid: "shop-a",
  title: "Anterior",
  focal_x: 50,
  focal_y: 50,
  position: 1,
  revision: 3,
  published_revision: 3,
  published_title: "Anterior",
  has_image: 1,
  image_version: "image-1",
  active: 1,
};
let draft = ["p1"];
let published = ["p1"];
let available = true;
const conn = {
  execute: async (sql, params = []) => {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith("SELECT id, title, revision"))
      return [
        [
          ...(params[0] === row.id && params[1] === row.cid
            ? [{ ...row }]
            : []),
        ],
      ];
    if (statement.startsWith("SELECT title,")) return [[{ ...row }]];
    if (statement.startsWith("SELECT id FROM products"))
      return [
        params
          .slice(1)
          .filter((id) => ["p1", "p2"].includes(id) && params[0] === row.cid)
          .map((id) => ({ id })),
      ];
    if (statement.startsWith("SELECT p.id FROM catalog_collection_items")) {
      assert.deepEqual(params, [`list-${row.cid}`, row.id, row.cid]);
      return [available && draft.length ? [{ id: draft[0] }] : []];
    }
    if (statement.startsWith("UPDATE catalog_collections SET title")) {
      [row.title, row.focal_x, row.focal_y, row.position] = params;
      row.revision++;
      return [{}];
    }
    if (statement.startsWith("DELETE FROM catalog_collection_items")) {
      if (statement.includes("stage = 'draft'")) draft = [];
      else published = [];
      return [{}];
    }
    if (
      statement.startsWith("INSERT INTO catalog_collection_items") &&
      statement.includes("SELECT collection_id")
    ) {
      published = [...draft];
      return [{}];
    }
    if (statement.startsWith("INSERT INTO catalog_collection_items")) {
      for (let index = 0; index < params.length; index += 3)
        draft.push(params[index + 1]);
      return [{}];
    }
    if (
      statement.startsWith("UPDATE catalog_collections SET published_title")
    ) {
      row.published_title = row.title;
      row.published_revision = row.revision;
      row.active = 1;
      return [{}];
    }
    if (statement.startsWith("UPDATE catalog_collections SET active = 0")) {
      row.active = 0;
      return [{}];
    }
    throw new Error(`Unexpected statement: ${statement}`);
  },
};
pool.withTransaction = async (callback) => {
  const before = {
    row: { ...row },
    draft: [...draft],
    published: [...published],
  };
  try {
    return await callback(conn);
  } catch (error) {
    row = before.row;
    draft = before.draft;
    published = before.published;
    throw error;
  }
};
pool.query = async (sql, params = []) => {
  if (sql.includes("COUNT(*) AS count") && sql.includes("GROUP BY")) {
    assert.match(sql, /ci\.stage = 'published'/);
    assert.match(sql, /p\.activo = 1 AND p\.stock > 0/);
    assert.deepEqual(params, [`list-${params[1]}`, params[1], params[1]]);
    return row.cid === params[1] && row.active && available && published.length
      ? [
          {
            id: row.id,
            title: row.published_title,
            version: "image-1",
            focal_x: 50,
            focal_y: 50,
            count: published.length,
          },
        ]
      : [];
  }
  if (sql.includes("FROM catalog_collections cc"))
    return params[0] === row.id && params[1] === row.cid
      ? [{ ...row, product_count: draft.length }]
      : [];
  if (sql.startsWith("SELECT product_id"))
    return draft.map((product_id) => ({ product_id }));
  throw new Error(`Unexpected query: ${sql}`);
};
const service = require("../dist/services/collections.js");
const { collectionDraftSchema } = require("../dist/routes/collections.js");
test("drafts stay private until activation; invalid publication rolls back and collections remain scoped", async () => {
  const input = {
    title: "Nueva selección",
    focalX: 20,
    focalY: 65,
    position: 2,
    productIds: ["p2", "p1"],
    baseRevision: 3,
    action: "draft",
  };
  const saved = await service.saveCollection("shop-a", "c1", input);
  assert.equal(saved.revision, 4);
  assert.equal(saved.hasUnpublishedChanges, true);
  assert.deepEqual(saved.productIds, ["p2", "p1"]);
  assert.match(saved.imageUrl, /comercioId=shop-a/);
  let live = await service.publicCollections("shop-a", "list-shop-a");
  assert.equal(live[0].title, "Anterior");
  assert.deepEqual(published, ["p1"]);
  assert.deepEqual(
    await service.publicCollections("shop-b", "list-shop-b"),
    [],
  );
  await assert.rejects(
    service.getCollection("shop-b", "c1"),
    (error) => error.status === 404,
  );
  await assert.rejects(
    service.publishCollection("shop-a", "c1", 3),
    (error) => error.status === 409,
  );
  available = false;
  await assert.rejects(
    service.saveCollection("shop-a", "c1", {
      ...input,
      baseRevision: 4,
      title: "No publicar",
      action: "publish",
    }),
    (error) => error.status === 400,
  );
  assert.equal(row.title, "Nueva selección");
  assert.equal(row.revision, 4);
  assert.deepEqual(published, ["p1"]);
  assert.deepEqual(
    await service.publicCollections("shop-a", "list-shop-a"),
    [],
    "empty/unavailable collections are hidden",
  );
  available = true;
  await service.publishCollection("shop-a", "c1", 4);
  live = await service.publicCollections("shop-a", "list-shop-a");
  assert.equal(live[0].title, "Nueva selección");
  assert.deepEqual(published, ["p2", "p1"]);
  assert.equal(
    (await service.getCollection("shop-a", "c1")).hasUnpublishedChanges,
    false,
  );
  await service.pauseCollection("shop-a", "c1", 4);
  assert.deepEqual(
    await service.publicCollections("shop-a", "list-shop-a"),
    [],
  );
});
test("draft input allows incomplete drafts but bounds selection, frame and concurrency fields", () => {
  const draft = {
    title: "",
    focalX: 50,
    focalY: 50,
    position: 1,
    productIds: [],
    baseRevision: 0,
    action: "draft",
  };
  assert.doesNotThrow(() => collectionDraftSchema.parse(draft));
  for (const invalid of [
    { productIds: ["p1", "p1"] },
    { position: 0 },
    { focalX: 101 },
    { baseRevision: -1 },
    { active: true },
  ])
    assert.equal(
      collectionDraftSchema.safeParse({ ...draft, ...invalid }).success,
      false,
    );
});
