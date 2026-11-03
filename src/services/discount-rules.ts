import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { execute, query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type {
  DiscountBasis,
  DiscountRule,
  DiscountTier,
} from "../types.js";
import { getDefaultComercioId } from "./comercios.js";

type RuleRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  nombre: string;
  descripcion: string;
  basis: DiscountBasis;
  price_list_id: string | null;
  activa: number;
};

type TierRow = RowDataPacket & {
  rule_id: string;
  desde: string | number;
  porcentaje: string | number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function mapRule(row: RuleRow, tiers: DiscountTier[]): DiscountRule {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? "",
    basis: row.basis,
    priceListId: row.price_list_id,
    activa: Boolean(row.activa),
    tiers: [...tiers].sort((a, b) => a.desde - b.desde),
  };
}

async function loadTiers(
  ruleIds: string[]
): Promise<Map<string, DiscountTier[]>> {
  const map = new Map<string, DiscountTier[]>();
  if (!ruleIds.length) return map;
  const ph = ruleIds.map(() => "?").join(",");
  const rows = await query<TierRow[]>(
    `SELECT rule_id, desde, porcentaje FROM discount_rule_tiers
     WHERE rule_id IN (${ph}) ORDER BY desde ASC`,
    ruleIds
  );
  for (const row of rows) {
    const bag = map.get(row.rule_id) ?? [];
    bag.push({ desde: num(row.desde), porcentaje: num(row.porcentaje) });
    map.set(row.rule_id, bag);
  }
  return map;
}

export async function listDiscountRules(
  comercioId?: string,
  onlyActive = false
): Promise<DiscountRule[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const rows = await query<RuleRow[]>(
    onlyActive
      ? `SELECT * FROM discount_rules WHERE comercio_id = ? AND activa = 1 ORDER BY nombre ASC`
      : `SELECT * FROM discount_rules WHERE comercio_id = ? ORDER BY nombre ASC`,
    [cid]
  );
  const tiers = await loadTiers(rows.map((r) => r.id));
  return rows.map((r) => mapRule(r, tiers.get(r.id) ?? []));
}

export async function getDiscountRule(
  id: string
): Promise<DiscountRule | null> {
  const rows = await query<RuleRow[]>(
    `SELECT * FROM discount_rules WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  const tiers = await loadTiers([id]);
  return mapRule(rows[0], tiers.get(id) ?? []);
}

export async function upsertDiscountRule(input: {
  id?: string;
  comercioId?: string;
  nombre: string;
  descripcion?: string;
  basis?: DiscountBasis;
  priceListId?: string | null;
  activa?: boolean;
  tiers: DiscountTier[];
}): Promise<DiscountRule> {
  const nombre = input.nombre.trim();
  if (!nombre) throw new HttpError(400, "El nombre es obligatorio.");
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const tiers = normalizeTiers(input.tiers);
  const id = input.id ?? nextId("dr");

  await withTransaction(async (conn) => {
    if (input.id) {
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE discount_rules
         SET nombre = ?, descripcion = ?, basis = ?, price_list_id = ?, activa = ?
         WHERE id = ?`,
        [
          nombre,
          input.descripcion?.trim() ?? "",
          input.basis ?? "amount",
          input.priceListId ?? null,
          input.activa === false ? 0 : 1,
          id,
        ]
      );
      if (result.affectedRows === 0) {
        throw new HttpError(404, "Regla no encontrada.");
      }
      await conn.execute(`DELETE FROM discount_rule_tiers WHERE rule_id = ?`, [
        id,
      ]);
    } else {
      await conn.execute(
        `INSERT INTO discount_rules
         (id, comercio_id, nombre, descripcion, basis, price_list_id, activa)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          comercioId,
          nombre,
          input.descripcion?.trim() ?? "",
          input.basis ?? "amount",
          input.priceListId ?? null,
          input.activa === false ? 0 : 1,
        ]
      );
    }
    for (const t of tiers) {
      await conn.execute(
        `INSERT INTO discount_rule_tiers (rule_id, desde, porcentaje)
         VALUES (?, ?, ?)`,
        [id, t.desde, t.porcentaje]
      );
    }
  });

  const rule = await getDiscountRule(id);
  if (!rule) throw new HttpError(500, "No se pudo guardar la regla.");
  return rule;
}

export async function deleteDiscountRule(id: string): Promise<void> {
  const result = await execute(`DELETE FROM discount_rules WHERE id = ?`, [id]);
  if (result.affectedRows === 0) {
    throw new HttpError(404, "Regla no encontrada.");
  }
}

export function normalizeTiers(tiers: DiscountTier[]): DiscountTier[] {
  const cleaned = tiers
    .map((t) => ({
      desde: Math.max(0, Number(t.desde) || 0),
      porcentaje: Math.min(100, Math.max(0, Number(t.porcentaje) || 0)),
    }))
    .sort((a, b) => a.desde - b.desde);
  // dedupe por desde
  const map = new Map<number, DiscountTier>();
  for (const t of cleaned) map.set(t.desde, t);
  const out = [...map.values()].sort((a, b) => a.desde - b.desde);
  if (!out.length) out.push({ desde: 0, porcentaje: 0 });
  return out;
}

/** Elige el escalón aplicable (mayor umbral <= valor). */
export function resolveTierPercent(
  tiers: DiscountTier[],
  value: number
): { porcentaje: number; desde: number } {
  const sorted = normalizeTiers(tiers);
  let chosen = sorted[0] ?? { desde: 0, porcentaje: 0 };
  for (const t of sorted) {
    if (value >= t.desde) chosen = t;
  }
  return { porcentaje: chosen.porcentaje, desde: chosen.desde };
}
