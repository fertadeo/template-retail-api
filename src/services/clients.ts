import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type { Client } from "../types.js";
import { getDefaultComercioId } from "./comercios.js";
import { getDefaultPriceListId, getPriceList } from "./price-lists.js";

type ClientRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  nombre: string;
  email: string;
  telefono: string;
  direccion: string;
  rfc: string;
  notas: string;
  price_list_id: string | null;
};

function map(row: ClientRow): Client {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    direccion: row.direccion,
    rfc: row.rfc,
    notas: row.notas,
    priceListId: row.price_list_id,
  };
}

export async function listClients(comercioId?: string): Promise<Client[]> {
  const cid = comercioId || (await getDefaultComercioId());
  const rows = await query<ClientRow[]>(
    `SELECT * FROM clients WHERE comercio_id = ? ORDER BY nombre ASC`,
    [cid]
  );
  return rows.map(map);
}

export async function getClient(id: string): Promise<Client | null> {
  const rows = await query<ClientRow[]>(
    `SELECT * FROM clients WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function upsertClient(input: {
  id?: string;
  comercioId?: string;
  nombre: string;
  email?: string;
  telefono?: string;
  direccion?: string;
  rfc?: string;
  notas?: string;
  priceListId?: string | null;
}): Promise<Client> {
  const nombre = input.nombre.trim();
  if (!nombre) throw new HttpError(400, "El nombre es obligatorio.");
  const comercioId = input.comercioId || (await getDefaultComercioId());

  let priceListId: string | null = input.priceListId ?? null;
  if (priceListId) {
    const list = await getPriceList(priceListId);
    if (!list) priceListId = null;
  }

  const email = (input.email ?? "").trim();
  const telefono = (input.telefono ?? "").trim();
  const direccion = (input.direccion ?? "").trim();
  const rfc = (input.rfc ?? "").trim().toUpperCase();
  const notas = (input.notas ?? "").trim();

  if (input.id) {
    const result = await execute(
      `UPDATE clients
       SET nombre = ?, email = ?, telefono = ?, direccion = ?,
           rfc = ?, notas = ?, price_list_id = ?, comercio_id = ?
       WHERE id = ?`,
      [
        nombre,
        email,
        telefono,
        direccion,
        rfc,
        notas,
        priceListId,
        comercioId,
        input.id,
      ]
    );
    if (result.affectedRows === 0) {
      throw new HttpError(404, "Cliente no encontrado.");
    }
    const updated = await getClient(input.id);
    if (!updated) throw new HttpError(404, "Cliente no encontrado.");
    return updated;
  }

  const id = nextId("c");
  await execute(
    `INSERT INTO clients
     (id, comercio_id, nombre, email, telefono, direccion, rfc, notas, price_list_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, comercioId, nombre, email, telefono, direccion, rfc, notas, priceListId]
  );
  const created = await getClient(id);
  if (!created) throw new HttpError(500, "No se pudo crear el cliente.");
  return created;
}

export async function resolveClientPriceListId(
  clientId: string | null | undefined,
  comercioId?: string
): Promise<string> {
  if (clientId) {
    const client = await getClient(clientId);
    if (client?.priceListId) {
      const list = await getPriceList(client.priceListId);
      if (list?.activa) return list.id;
    }
  }
  return getDefaultPriceListId(comercioId);
}
