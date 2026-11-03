import type { Request } from "express";

/**
 * Sucursal activa desde header/query.
 * - ausente / "all" / "*" → todas (admin/superadmin)
 * - id concreto → filtrar esa sucursal
 */
export function readBranchId(req: Request): string | undefined {
  const header = req.header("x-branch-id");
  if (header?.trim()) {
    const v = header.trim();
    if (v === "all" || v === "*") return undefined;
    return v;
  }
  if (typeof req.query.branchId === "string" && req.query.branchId.trim()) {
    const v = req.query.branchId.trim();
    if (v === "all" || v === "*") return undefined;
    return v;
  }
  return undefined;
}

/** Operador/vendedor activo (POS / auditoría). */
export function readVendedorId(req: Request): string | undefined {
  const header = req.header("x-vendedor-id");
  if (header?.trim()) return header.trim();
  if (typeof req.query.vendedorId === "string" && req.query.vendedorId.trim()) {
    return req.query.vendedorId.trim();
  }
  return undefined;
}
