import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { HttpError } from "./lib/http.js";
import { apiRouter } from "./routes/index.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin.split(",").map((o) => o.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "retail-360-api",
      version: "0.2.0",
      health: "/api/health",
    });
  });

  app.use("/api", apiRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Ruta no encontrada." });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: "Datos inválidos.",
          details: err.flatten(),
        });
        return;
      }
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error(err);
      res.status(500).json({ error: "Error interno del servidor." });
    }
  );

  return app;
}
