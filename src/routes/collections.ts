import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { readComercioId } from "../lib/comercio-req.js";
import { resolveComercioId } from "../services/comercios.js";
import * as collections from "../services/collections.js";
export const collectionDraftSchema = z
  .object({
    title: z.string().trim().max(80),
    focalX: z.number().int().min(0).max(100),
    focalY: z.number().int().min(0).max(100),
    position: z.number().int().min(1).max(1000),
    productIds: z
      .array(z.string().min(1).max(36))
      .max(2000)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Hay productos repetidos.",
      ),
    imageDataUrl: z.string().max(700000).nullable().optional(),
    baseRevision: z.number().int().min(0),
    action: z.enum(["draft", "publish"]),
  })
  .strict();
const revisionSchema = z.object({ revision: z.number().int().min(1) }).strict();
export const collectionRouter = Router();
collectionRouter.use((req, res, next) => {
  if (!["superadmin", "administrador"].includes(res.locals.user.role))
    throw new HttpError(
      403,
      "Solo un administrador puede diseñar el inicio de la tienda.",
    );
  next();
});
collectionRouter.get("/", async (req, res) =>
  res.json(
    await collections.listCollections(
      await resolveComercioId(readComercioId(req)),
    ),
  ),
);
collectionRouter.get("/products", async (req, res) => {
  const options = z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      q: z.string().trim().max(100).default(""),
      ids: z.string().max(2000).optional(),
    })
    .parse(req.query);
  const ids = options.ids?.split(",").filter(Boolean);
  if (ids && (ids.length > 24 || ids.some((id) => id.length > 36)))
    throw new HttpError(400, "La página de selección no es válida.");
  res.json(
    await collections.pickerProducts(
      await resolveComercioId(readComercioId(req)),
      { ...options, ids },
    ),
  );
});
collectionRouter.get("/product-ids", async (req, res) => {
  const q = z
    .string()
    .trim()
    .max(100)
    .parse(req.query.q ?? "");
  res.json({
    ids: await collections.pickerIds(
      await resolveComercioId(readComercioId(req)),
      q,
    ),
  });
});
collectionRouter.get("/:id/image", async (req, res) => {
  const image = await collections.collectionImage(
    await resolveComercioId(readComercioId(req)),
    req.params.id,
    false,
    typeof req.query.v === "string" ? req.query.v : undefined,
  );
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(image);
});
collectionRouter.get("/:id", async (req, res) =>
  res.json(
    await collections.getCollection(
      await resolveComercioId(readComercioId(req)),
      req.params.id,
    ),
  ),
);
collectionRouter.post("/", async (req, res) =>
  res
    .status(201)
    .json(
      await collections.saveCollection(
        await resolveComercioId(readComercioId(req)),
        undefined,
        collectionDraftSchema.parse(req.body),
      ),
    ),
);
collectionRouter.put("/:id", async (req, res) =>
  res.json(
    await collections.saveCollection(
      await resolveComercioId(readComercioId(req)),
      req.params.id,
      collectionDraftSchema.parse(req.body),
    ),
  ),
);
collectionRouter.post("/:id/publish", async (req, res) =>
  res.json(
    await collections.publishCollection(
      await resolveComercioId(readComercioId(req)),
      req.params.id,
      revisionSchema.parse(req.body).revision,
    ),
  ),
);
collectionRouter.post("/:id/pause", async (req, res) =>
  res.json(
    await collections.pauseCollection(
      await resolveComercioId(readComercioId(req)),
      req.params.id,
      revisionSchema.parse(req.body).revision,
    ),
  ),
);
