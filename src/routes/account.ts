import { Router } from "express";
import { z } from "zod";
import { changeOwnPassword, startViewAs, stopViewAs } from "../lib/auth.js";
import * as account from "../services/account.js";

export const accountRouter = Router();
accountRouter.get("/profile", async (_req, res) =>
  res.json(await account.getAccountProfile(res.locals.user.id)),
);
accountRouter.patch("/profile", async (req, res) => {
  const input = z
    .object({
      nombre: z.string().trim().min(1).max(160),
      phone: z.string().trim().max(40),
      avatarDataUrl: z.string().max(700000).nullable().optional(),
      contactEmail: z.union([
        z.literal(""),
        z.string().trim().email().max(254),
      ]),
    })
    .strict()
    .parse(req.body);
  res.json(await account.updateAccountProfile(res.locals.user.id, input));
});
accountRouter.get("/profile/avatar", async (_req, res) => {
  const avatar = await account.accountAvatar(res.locals.user.id);
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(avatar);
});
accountRouter.put("/password", changeOwnPassword);
accountRouter.post("/view-as", startViewAs);
accountRouter.post("/view-as/stop", stopViewAs);
