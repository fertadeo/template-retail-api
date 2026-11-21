import { cashRouter } from "./cash.js";
import { accountRouter } from "./account.js";
import { publicCatalogRouter, privateCatalogRouter } from "./catalog.js";
import { login, logout, requireSession, requireAccountManager } from "../lib/auth.js";
import { Router } from "express";
import { z } from "zod";
import { readComercioId } from "../lib/comercio-req.js";

import { sendError } from "../lib/http.js";
import * as clientsSvc from "../services/clients.js";
import * as comerciosSvc from "../services/comercios.js";
import * as discountRulesSvc from "../services/discount-rules.js";
import * as mediaSvc from "../services/media.js";
import * as ordersSvc from "../services/orders.js";
import * as priceListsSvc from "../services/price-lists.js";
import * as productsSvc from "../services/products.js";
import * as quotesSvc from "../services/quotes.js";
import * as usersSvc from "../services/users.js";
import * as categoriesSvc from "../services/categories.js";
import { testConnection } from "../db/pool.js";

export const apiRouter = Router();
apiRouter.use("/catalog/public", publicCatalogRouter);
apiRouter.use(requireSession);
apiRouter.use("/cash", cashRouter);
apiRouter.use("/auth", accountRouter);
apiRouter.use("/users", requireAccountManager);
apiRouter.use("/catalog", privateCatalogRouter);
apiRouter.post("/auth/login", login);
apiRouter.post("/auth/logout", logout);
apiRouter.get("/auth/session", (_req, res) => {
  res.json({ user: res.locals.user, actor: res.locals.actor ?? null });
});

// The installation has one local business profile, not a selectable store list.
apiRouter.get("/business", async (_req, res) => {
  try {
    const id = await comerciosSvc.getDefaultComercioId();
    res.json(await comerciosSvc.getComercio(id));
  } catch (err) { sendError(res, err); }
});

apiRouter.get("/health", async (_req, res) => {
  const db = await testConnection();
  res.json({
    ok: true,
    service: "retail-360-api",
    db,
  });
});

apiRouter.get("/dashboard/stats", async (req, res) => {
  try {
    const day =
      typeof req.query.day === "string" ? req.query.day : undefined;
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    res.json(await ordersSvc.dashboardStats(day, comercioId, branchId));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/reports/sales-by-vendor", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    const from =
      typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const canal = z
      .enum(["pos", "pedido", "mayorista"])
      .optional()
      .parse(
        typeof req.query.canal === "string" ? req.query.canal : undefined
      );
    res.json(
      await ordersSvc.salesByVendor({
        comercioId,
        branchId,
        from,
        to,
        canal,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Price lists —— */
apiRouter.get("/price-lists", async (req, res) => {
  try {
    const onlyActive = req.query.active === "1" || req.query.active === "true";
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    res.json(await priceListsSvc.listPriceLists(onlyActive, comercioId));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/price-lists", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = z
      .object({
        nombre: z.string(),
        codigo: z.string().optional(),
        activa: z.boolean().optional(),
        esDefault: z.boolean().optional(),
      })
      .parse(req.body);
    res.status(201).json(
      await priceListsSvc.createPriceList({ ...body, comercioId })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/price-lists/:id", async (req, res) => {
  try {
    const body = z
      .object({
        nombre: z.string().optional(),
        codigo: z.string().optional(),
        activa: z.boolean().optional(),
        esDefault: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(await priceListsSvc.updatePriceList(req.params.id, body));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/price-lists/:id/set-default", async (req, res) => {
  try {
    res.json(await priceListsSvc.setDefaultPriceList(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Categories —— */
apiRouter.get("/categories", async (req, res) => {
  try {
    const onlyActive = req.query.active === "1" || req.query.active === "true";
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    res.json(await categoriesSvc.listCategories(onlyActive, comercioId));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/categories", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = z
      .object({
        nombre: z.string(),
        codigo: z.string().optional(),
      })
      .parse(req.body);
    res.status(201).json(
      await categoriesSvc.createCategory({ ...body, comercioId })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/categories/:id", async (req, res) => {
  try {
    const body = z
      .object({
        nombre: z.string().optional(),
        activa: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(await categoriesSvc.updateCategory(req.params.id, body));
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Products —— */
apiRouter.get("/products/counts", async (req, res) => {
  try {
    const started = performance.now();
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const { q, category } = z.object({ q: z.string().trim().max(200).default(""), category: z.string().max(100).default("") }).parse(req.query);
    const counts = await productsSvc.productHealthCounts(comercioId, q, category);
    res.setHeader("Server-Timing", `counts;dur=${(performance.now() - started).toFixed(1)}`);
    res.json(counts);
  } catch (err) { sendError(res, err); }
});

apiRouter.get("/products", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    if (req.query.page !== undefined) {
      const opts = z.object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(40),
        q: z.string().trim().max(200).default(""),
        category: z.string().max(100).default(""),
        health: z.enum(["all", "ready", "attention", "critical"]).default("all"),
        sort: z.enum(["nombre", "recent", "oldest", "sold_desc", "sold_asc"]).default("nombre"),
        pos: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
      }).parse(req.query);
      const started = performance.now();
      const result = await productsSvc.listProductsPage(comercioId, opts);
      res.setHeader("Server-Timing", `products;dur=${(performance.now() - started).toFixed(1)}`);
      res.json(result);
    } else {
      res.json(await productsSvc.listProducts(comercioId));
    }
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/products/:id", async (req, res) => {
  try {
    const product = await productsSvc.getProduct(req.params.id);
    if (!product) {
      res.status(404).json({ error: "Producto no encontrado." });
      return;
    }
    res.json(product);
  } catch (err) {
    sendError(res, err);
  }
});

const productBody = z.object({
  id: z.string().optional(),
  comercioId: z.string().optional(),
  sku: z.string(),
  nombre: z.string(),
  categoria: z.string().trim().min(1).max(64),
  costo: z.number(),
  stock: z.number(),
  activo: z.boolean().optional(),
  descripcion: z.string().optional(),
  precios: z.record(z.string(), z.number()),
});

apiRouter.post("/products", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(
      readComercioId(req) ?? req.body?.comercioId
    );
    const body = productBody.parse({ ...req.body, comercioId });
    res.status(201).json(await productsSvc.upsertProduct(body));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/products/:id", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(
      readComercioId(req) ?? req.body?.comercioId
    );
    const body = productBody.parse({
      ...req.body,
      id: req.params.id,
      comercioId,
    });
    res.json(await productsSvc.upsertProduct(body));
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Clients —— */
apiRouter.get("/clients", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    res.json(await clientsSvc.listClients(comercioId));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/clients/:id", async (req, res) => {
  try {
    const client = await clientsSvc.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: "Cliente no encontrado." });
      return;
    }
    res.json(client);
  } catch (err) {
    sendError(res, err);
  }
});

const clientBody = z.object({
  id: z.string().optional(),
  comercioId: z.string().optional(),
  nombre: z.string(),
  email: z.string().optional(),
  telefono: z.string().optional(),
  direccion: z.string().optional(),
  rfc: z.string().optional(),
  notas: z.string().optional(),
  priceListId: z.string().nullable().optional(),
});

apiRouter.post("/clients", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(
      readComercioId(req) ?? req.body?.comercioId
    );
    const body = clientBody.parse({ ...req.body, comercioId });
    res.status(201).json(await clientsSvc.upsertClient(body));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/clients/:id", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(
      readComercioId(req) ?? req.body?.comercioId
    );
    const body = clientBody.parse({
      ...req.body,
      id: req.params.id,
      comercioId,
    });
    res.json(await clientsSvc.upsertClient(body));
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Orders —— */
apiRouter.get("/orders", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    const canal = z
      .enum(["pos", "pedido", "mayorista"])
      .optional()
      .parse(
        typeof req.query.canal === "string" ? req.query.canal : undefined
      );
    res.json(await ordersSvc.listOrders(canal, comercioId, branchId));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/orders/:id", async (req, res) => {
  try {
    const order = await ordersSvc.getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ error: "Pedido no encontrado." });
      return;
    }
    res.json(order);
  } catch (err) {
    sendError(res, err);
  }
});

const lineSchema = z.object({
  productId: z.string(),
  nombre: z.string().optional().default(""),
  cantidad: z.number(),
  precioUnitario: z.number().optional().default(0),
});

apiRouter.post("/orders", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    const vendedorId = res.locals.user.id;
    const body = z
      .object({
        clientId: z.string(),
        lines: z.array(lineSchema).min(1),
      })
      .parse(req.body);
    res.status(201).json(
      await ordersSvc.createPedido({
        ...body,
        comercioId,
        branchId,
        vendedorId,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/pos/checkout", async (req, res) => {
  try {
    if (res.locals.user.role === "visitante") {
      res.status(403).json({ error: "No tenés permiso para cobrar ventas." });
      return;
    }
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    const body = z
      .object({
        lines: z.array(lineSchema).min(1),
        clientId: z.string().nullable().optional(),
        priceListId: z.string().nullable().optional(),
        conEnvio: z.boolean().optional(),
        envioCosto: z.number().optional(),
        direccionEnvio: z.string().optional(),
        telefonoContacto: z.string().optional(),
        metodoPago: z.enum(["efectivo", "transferencia"]),
      })
      .parse(req.body);
    res.status(201).json(
      await ordersSvc.createPosSale({
        ...body,
        comercioId,
        branchId,
        vendedorId: res.locals.user.id,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/wholesale/orders", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const branchId = null;
    const vendedorId = res.locals.user.id;
    const body = z
      .object({
        clientId: z.string(),
        lines: z.array(lineSchema).min(1),
      })
      .parse(req.body);
    res.status(201).json(
      await ordersSvc.createMayoristaPedido({
        ...body,
        comercioId,
        branchId,
        vendedorId,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/wholesale/orders", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    res.json(
      await ordersSvc.listOrders(
        "mayorista",
        comercioId,
        null
      )
    );
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Users / Centro de cuentas —— */
const userRoleSchema = z.enum([
  "superadmin",
  "administrador",
  "vendedor",
  "visitante",
]);

const userBodySchema = z.object({
  email: z.string(),
  nombre: z.string(),
  password: z.string().optional(),
  role: userRoleSchema,
  activa: z.boolean().optional(),
  functions: z.array(z.string()).optional(),
});

apiRouter.get("/users", async (req, res) => {
  try {
    const onlyActive = req.query.active === "1" || req.query.active === "true";
    res.json(await usersSvc.listUsers(onlyActive));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/users/functions", async (_req, res) => {
  try {
    res.json(usersSvc.listAppFunctions());
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/users/:id", async (req, res) => {
  try {
    const user = await usersSvc.getUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado." });
      return;
    }
    res.json(user);
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/users", async (req, res) => {
  try {
    const body = userBodySchema.parse(req.body);
    res.status(201).json(await usersSvc.upsertUser(body));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/users/:id", async (req, res) => {
  try {
    const body = userBodySchema.parse(req.body);
    res.json(await usersSvc.upsertUser({ ...body, id: req.params.id }));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.delete("/users/:id", async (req, res) => {
  try {
    res.json(await usersSvc.softDeleteUser(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/users/:id/restore", async (req, res) => {
  try {
    res.json(await usersSvc.restoreUser(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Channels (WooCommerce / Mercado Libre) —— */
/* —— Descuentos escalonados —— */
const tierSchema = z.object({
  desde: z.number(),
  porcentaje: z.number(),
});

apiRouter.get("/discount-rules", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const onlyActive = req.query.active === "1" || req.query.active === "true";
    res.json(await discountRulesSvc.listDiscountRules(comercioId, onlyActive));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/discount-rules/:id", async (req, res) => {
  try {
    const rule = await discountRulesSvc.getDiscountRule(req.params.id);
    if (!rule) {
      res.status(404).json({ error: "Regla no encontrada." });
      return;
    }
    res.json(rule);
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/discount-rules", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = z
      .object({
        nombre: z.string(),
        descripcion: z.string().optional(),
        basis: z.enum(["amount", "qty"]).optional(),
        priceListId: z.string().nullable().optional(),
        activa: z.boolean().optional(),
        tiers: z.array(tierSchema).min(1),
      })
      .parse(req.body);
    res.status(201).json(
      await discountRulesSvc.upsertDiscountRule({ ...body, comercioId })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/discount-rules/:id", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = z
      .object({
        nombre: z.string(),
        descripcion: z.string().optional(),
        basis: z.enum(["amount", "qty"]).optional(),
        priceListId: z.string().nullable().optional(),
        activa: z.boolean().optional(),
        tiers: z.array(tierSchema).min(1),
      })
      .parse(req.body);
    res.json(
      await discountRulesSvc.upsertDiscountRule({
        ...body,
        id: req.params.id,
        comercioId,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.delete("/discount-rules/:id", async (req, res) => {
  try {
    await discountRulesSvc.deleteDiscountRule(req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Presupuestos —— */
const quoteLineSchema = z.object({
  productId: z.string().nullable().optional(),
  sku: z.string().optional(),
  nombre: z.string().optional(),
  cantidad: z.number(),
  precioUnitario: z.number().optional(),
  lineDescuentoPct: z.number().optional(),
});

const quoteBodySchema = z.object({
  clientId: z.string().nullable().optional(),
  clienteNombre: z.string().optional(),
  clienteEmail: z.string().optional(),
  clienteTelefono: z.string().optional(),
  priceListId: z.string().nullable().optional(),
  discountRuleId: z.string().nullable().optional(),
  discountMode: z.enum(["none", "rule", "manual"]).optional(),
  discountBasis: z.enum(["amount", "qty"]).optional(),
  tiers: z.array(tierSchema).optional(),
  descuentoManualPct: z.number().optional(),
  status: z
    .enum([
      "borrador",
      "enviado",
      "aceptado",
      "rechazado",
      "vencido",
      "convertido",
    ])
    .optional(),
  validezDias: z.number().optional(),
  notas: z.string().optional(),
  lines: z.array(quoteLineSchema).min(1),
});

apiRouter.get("/quotes", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const status = z
      .enum([
        "borrador",
        "enviado",
        "aceptado",
        "rechazado",
        "vencido",
        "convertido",
      ])
      .optional()
      .parse(
        typeof req.query.status === "string" ? req.query.status : undefined
      );
    res.json(await quotesSvc.listQuotes(comercioId, status));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/quotes/:id", async (req, res) => {
  try {
    const quote = await quotesSvc.getQuote(req.params.id);
    if (!quote) {
      res.status(404).json({ error: "Presupuesto no encontrado." });
      return;
    }
    res.json(quote);
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/quotes/preview", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = quoteBodySchema.parse(req.body);
    res.json(await quotesSvc.previewQuote({ ...body, comercioId }));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/quotes", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = quoteBodySchema.parse(req.body);
    res.status(201).json(await quotesSvc.upsertQuote({ ...body, comercioId }));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.patch("/quotes/:id", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = quoteBodySchema.parse(req.body);
    res.json(
      await quotesSvc.upsertQuote({
        ...body,
        id: req.params.id,
        comercioId,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/quotes/:id/status", async (req, res) => {
  try {
    const body = z
      .object({
        status: z.enum([
          "borrador",
          "enviado",
          "aceptado",
          "rechazado",
          "vencido",
          "convertido",
        ]),
      })
      .parse(req.body);
    res.json(await quotesSvc.updateQuoteStatus(req.params.id, body.status));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.delete("/quotes/:id", async (req, res) => {
  try {
    await quotesSvc.deleteQuote(req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Product images —— */
apiRouter.get("/products/:id/images", async (req, res) => {
  try {
    const product = await productsSvc.getProduct(req.params.id);
    if (!product) {
      res.status(404).json({ error: "Producto no encontrado." });
      return;
    }
    res.json({
      imagenPrincipal: product.imagenPrincipal ?? null,
      imagenesSecundarias: product.imagenesSecundarias ?? [],
      items: [
        ...(product.imagenPrincipal ? [product.imagenPrincipal] : []),
        ...(product.imagenesSecundarias ?? []),
      ],
    });
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.post("/products/:id/images/primary", async (req, res) => {
  try {
    const body = z.object({ mediaId: z.string().min(1) }).parse(req.body);
    const items = await mediaSvc.setProductImagePrimary(
      req.params.id,
      body.mediaId
    );
    const split = mediaSvc.splitProductImages(items);
    res.json({ ...split, items });
  } catch (err) {
    sendError(res, err);
  }
});

/* —— Media library —— */
apiRouter.get("/media", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const kindRaw = String(req.query.kind ?? "all").toLowerCase();
    const kind =
      kindRaw === "image" || kindRaw === "images"
        ? "image"
        : kindRaw === "attachment" ||
            kindRaw === "attachments" ||
            kindRaw === "file" ||
            kindRaw === "files"
          ? "attachment"
          : "all";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const productId =
      typeof req.query.productId === "string" ? req.query.productId : undefined;
    const started = performance.now();
    const { page, pageSize } = z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(24),
    }).parse(req.query);
    const result = await mediaSvc.listMediaPage({ comercioId, kind, q: q.trim().slice(0, 200), productId, page, pageSize });
    res.setHeader("Server-Timing", `media;dur=${(performance.now() - started).toFixed(1)}`);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/media/:id/content", async (req, res) => {
  try {
    const media = await mediaSvc.getMediaContent(req.params.id, req.query.thumbnail === "1");
    if ("redirect" in media) { res.redirect(media.redirect); return; }
    res.setHeader("Content-Type", media.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    // Private HTTP cache stores each file separately; listing responses remain no-store.
    res.setHeader("Cache-Control", "private, max-age=300");
    if (!media.mime.startsWith("image/") && media.mime !== "application/pdf") res.attachment(media.filename);
    res.send(media.body);
  } catch (err) { sendError(res, err); }
});

const mediaBody = z.object({
  productId: z.string().nullable().optional(),
  kind: z.enum(["image", "attachment"]).optional(),
  filename: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  dataUrl: z.string().nullable().optional(),
  title: z.string().optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

apiRouter.post("/media", async (req, res) => {
  try {
    const comercioId = await comerciosSvc.resolveComercioId(readComercioId(req));
    const body = mediaBody.parse(req.body);
    res.status(201).json(
      await mediaSvc.createMedia({
        comercioId,
        productId: body.productId ?? null,
        kind: body.kind,
        filename: body.filename,
        mime: body.mime,
        sizeBytes: body.sizeBytes,
        dataUrl: body.dataUrl ?? null,
        title: body.title,
        isPrimary: body.isPrimary,
        sortOrder: body.sortOrder,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

const mediaPatchBody = z.object({
  productId: z.string().nullable().optional(),
  title: z.string().optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

apiRouter.patch("/media/:id", async (req, res) => {
  try {
    const body = mediaPatchBody.parse(req.body);
    res.json(await mediaSvc.updateMedia(req.params.id, body));
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.delete("/media/:id", async (req, res) => {
  try {
    await mediaSvc.deleteMedia(req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});
