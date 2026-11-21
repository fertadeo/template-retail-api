import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { readComercioId } from "../lib/comercio-req.js";
import { resolveComercioId } from "../services/comercios.js";
import * as cash from "../services/cash.js";
const amount = z
  .number()
  .finite()
  .min(0)
  .max(9999999999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001,
    "Usá hasta dos decimales.",
  );
export const cashRouter = Router();
cashRouter.get("/current", async (req, res) =>
  res.json(
    await cash.currentCash(await resolveComercioId(readComercioId(req))),
  ),
);
cashRouter.get("/history", async (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(req.query.page ?? 1);
  res.json(
    await cash.cashHistory(await resolveComercioId(readComercioId(req)), page),
  );
});
cashRouter.get("/daily-sales", async (req, res) => {
  const { from, to } = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(req.query);
  res.json(
    await cash.dailySales(
      await resolveComercioId(readComercioId(req)),
      from,
      to,
    ),
  );
});
cashRouter.use((_req, res, next) => {
  if (
    !["superadmin", "administrador", "vendedor"].includes(res.locals.user.role)
  )
    throw new HttpError(403, "No tenés permiso para operar la caja.");
  next();
});
cashRouter.post("/open", async (req, res) => {
  const input = z.object({ opening: amount }).strict().parse(req.body);
  res
    .status(201)
    .json(
      await cash.openCash(
        await resolveComercioId(readComercioId(req)),
        res.locals.user.id,
        input.opening,
      ),
    );
});
cashRouter.post("/:id/close", async (req, res) => {
  const input = z
    .object({
      counted: amount,
      version: z.number().int().min(1),
      note: z.string().trim().max(300),
    })
    .strict()
    .parse(req.body);
  res.json(
    await cash.closeCash(
      await resolveComercioId(readComercioId(req)),
      res.locals.user,
      req.params.id,
      input,
    ),
  );
});
