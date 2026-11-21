import { collectionRouter } from "./collections.js";
import { collectionImage } from "../services/collections.js";
import { Router } from "express";
import { z } from "zod";
import { sendError, HttpError } from "../lib/http.js";
import * as catalog from "../services/catalog.js";
import { getMediaContent } from "../services/media.js";
import { getDefaultComercioId } from "../services/comercios.js";

export const cartSchema = z.object({
  expectedCurrency: z.enum(["ARS", "MXN", "USD", "UYU"]),
  items: z
    .array(
      z.object({
        productId: z.string().min(1).max(40),
        quantity: z.number().int().min(1).max(99),
        expectedUnitPrice: z.number().finite().min(0).max(9999999999.99),
      }),
    )
    .min(1)
    .max(30),
});
const checkoutSchema = cartSchema.extend({
  checkoutKey: z.string().uuid(),
  buyerName: z.string().trim().min(2).max(100),
  buyerPhone: z
    .string()
    .trim()
    .max(40)
    .refine(
      catalog.validPhone,
      "Indicá un teléfono válido con código de país.",
    ),
  buyerNote: z.string().trim().max(1000).default(""),
});
export const catalogSettingsSchema = z.object({
  publicEnabled: z.boolean(),
  whatsappPhone: z.string().trim().max(40),
  displayName: z.string().trim().max(100),
  welcomeText: z.string().trim().max(240),
  currency: z.enum(["ARS", "MXN", "USD", "UYU"]),
  orderTtlHours: z.number().int().min(1).max(168),
});

// In-process bounds for a single-process local installation. Trust only the local reverse proxy.
const buckets = new Map<string, { count: number; expires: number }>();
export const publicCatalogRouter = Router();
publicCatalogRouter.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST" || !["/cart", "/orders"].includes(req.path)) {
    next();
    return;
  }
  const now = Date.now();
  for (const [key, value] of buckets)
    if (value.expires <= now) buckets.delete(key);
  const key = `${req.ip}:${req.path}`;
  const bucket = buckets.get(key) ?? { count: 0, expires: now + 60_000 };
  const limit = req.path === "/orders" ? 30 : 120;
  if (bucket.count >= limit || (!buckets.has(key) && buckets.size >= 10000)) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error:
        "Recibimos varios intentos seguidos. Esperá un minuto y volvé a intentar.",
    });
    return;
  }
  bucket.count++;
  buckets.set(key, bucket);
  next();
});
publicCatalogRouter.get("/", async (_req, res) => {
  try {
    res.json(await catalog.publicCatalogInfo());
  } catch (err) {
    sendError(res, err);
  }
});
publicCatalogRouter.get("/collections/:id/image", async (req, res) => {
  const cid = await catalog.publicMediaScope();
  const image = await collectionImage(
    cid,
    req.params.id,
    true,
    typeof req.query.v === "string" ? req.query.v : undefined,
    req.query.small === "1",
  );
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(image);
});
publicCatalogRouter.get("/products", async (req, res) => {
  try {
    const options = z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(48).default(24),
        q: z.string().trim().max(100).default(""),
        category: z.string().max(64).default(""),
        collection: z.string().max(36).default(""),
        sort: z
          .enum(["name", "price_asc", "price_desc", "recent", "featured"])
          .default("name"),
      })
      .parse(req.query);
    res.json(await catalog.publicProducts(options));
  } catch (err) {
    sendError(res, err);
  }
});
publicCatalogRouter.get("/products/:id", async (req, res) => {
  try {
    res.json(await catalog.publicProduct(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});
publicCatalogRouter.get("/media/:id", async (req, res) => {
  try {
    const cid = await catalog.publicMediaScope();
    const media = await getMediaContent(
      req.params.id,
      req.query.thumbnail === "1",
      { publicComercioId: cid },
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    if ("redirect" in media) {
      const url = new URL(media.redirect);
      if (!["http:", "https:"].includes(url.protocol))
        throw new HttpError(404, "Imagen no disponible.");
      res.redirect(url.toString());
      return;
    }
    res.setHeader("Content-Type", media.mime);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(media.body);
  } catch (err) {
    sendError(res, err);
  }
});
publicCatalogRouter.post("/cart", async (req, res) => {
  try {
    const input = cartSchema.parse(req.body);
    res.json(
      await catalog.reviewPublicCart(input.items, input.expectedCurrency),
    );
  } catch (err) {
    sendError(res, err);
  }
});
publicCatalogRouter.post("/orders", async (req, res) => {
  try {
    const result = await catalog.createPublicOrder(
      checkoutSchema.parse(req.body),
    );
    res.status(result.conflict ? 409 : 201).json(
      result.conflict
        ? {
            error:
              "Cambió el precio o la disponibilidad. Revisá el carrito antes de enviar.",
            cart: result.cart,
          }
        : result,
    );
  } catch (err) {
    sendError(res, err);
  }
});

// Mounted after session middleware. Settings writes require an administrator.
export const privateCatalogRouter = Router();
privateCatalogRouter.use("/collections", collectionRouter);
privateCatalogRouter.get("/settings", async (req, res) => {
  try {
    res.json({
      settings: await catalog.getCatalogSettings(await getDefaultComercioId()),
    });
  } catch (err) {
    sendError(res, err);
  }
});
privateCatalogRouter.put("/settings", async (req, res) => {
  try {
    if (!["superadmin", "administrador"].includes(res.locals.user.role))
      throw new HttpError(
        403,
        "Solo un administrador puede publicar o configurar el catálogo.",
      );
    const settings = catalogSettingsSchema.parse(req.body);
    res.json({
      settings: await catalog.saveCatalogSettings(
        await getDefaultComercioId(),
        settings,
      ),
    });
  } catch (err) {
    sendError(res, err);
  }
});
privateCatalogRouter.get("/orders", async (req, res) => {
  try {
    const options = z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        q: z.string().trim().max(100).default(""),
        status: z
          .enum([
            "pendiente",
            "en_preparacion",
            "listo_para_entrega",
            "entregado",
            "devolucion",
            "cancelado",
            "cobrado",
          ])
          .optional(),
      })
      .parse(req.query);
    res.json(
      await catalog.listCatalogOrders(await getDefaultComercioId(), options),
    );
  } catch (err) {
    sendError(res, err);
  }
});
privateCatalogRouter.patch("/orders/:id", async (req, res) => {
  try {
    if (res.locals.user.role === "visitante")
      throw new HttpError(403, "Esta cuenta solo puede consultar pedidos.");
    const { status } = z
      .object({
        status: z.enum([
          "pendiente",
          "en_preparacion",
          "listo_para_entrega",
          "entregado",
          "devolucion",
          "cancelado",
        ]),
      })
      .parse(req.body);
    res.json({
      order: await catalog.updateCatalogOrder(
        await getDefaultComercioId(),
        req.params.id,
        status,
      ),
    });
  } catch (err) {
    sendError(res, err);
  }
});
