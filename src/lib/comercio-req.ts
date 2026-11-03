import type { Request } from "express";

/** Lee comercio activo desde header o query. */
export function readComercioId(req: Request): string | undefined {
  const header = req.header("x-comercio-id");
  if (header?.trim()) return header.trim();
  if (typeof req.query.comercioId === "string" && req.query.comercioId.trim()) {
    return req.query.comercioId.trim();
  }
  return undefined;
}
