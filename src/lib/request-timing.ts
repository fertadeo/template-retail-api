import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

const timings = new AsyncLocalStorage<{ queries: number; sqlMs: number; waitMs: number }>();
export function recordReadTiming(waitMs: number, sqlMs: number) {
  const current = timings.getStore();
  if (current) { current.queries++; current.waitMs += waitMs; current.sqlMs += sqlMs; }
}

/** Observe catalog reads without logging queries, credentials or product data. */
export function catalogTiming(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET" || !/^\/api\/(products|media)(\/|$)/.test(req.path)) { next(); return; }
  const started = performance.now();
  const values = { queries: 0, sqlMs: 0, waitMs: 0 };
  timings.run(values, () => {
    const send = res.send;
    res.send = function (body) {
      const existing = res.getHeader("Server-Timing");
      res.setHeader("Server-Timing", [existing,
        `read_sql;dur=${values.sqlMs.toFixed(1)}`,
        `read_wait;dur=${values.waitMs.toFixed(1)}`,
        `read_queries;desc="${values.queries}"`,
        `before_send;dur=${(performance.now() - started).toFixed(1)}`,
      ].filter(Boolean).join(", "));
      return send.call(this, body);
    };
    res.on("finish", () => {
      const duration = performance.now() - started;
      if (duration >= 500) console.info("[catalog-read]", JSON.stringify({
        path: req.path, status: res.statusCode, ms: Math.round(duration),
        bytes: Number(res.getHeader("Content-Length")) || 0, ...values,
      }));
    });
    next();
  });
}
