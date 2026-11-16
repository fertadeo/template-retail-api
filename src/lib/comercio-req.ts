import type { Request } from "express";

/** Local-only installation: no store selection through request headers or query. */
export function readComercioId(_req: Request): undefined {
  return undefined;
}
