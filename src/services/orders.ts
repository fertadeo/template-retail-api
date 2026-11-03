import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { nextId } from "../lib/ids.js";
import type {
  Order,
  OrderCanal,
  OrderLine,
  OrderStatus,
  PaymentMethod,
} from "../types.js";
import { PRICE_LIST_MAYORISTA, productPrice } from "../types.js";
import { getClient, resolveClientPriceListId } from "./clients.js";
import {
  ensureActiveList,
  getDefaultPriceListId,
  getPriceList,
} from "./price-lists.js";
import { getProduct } from "./products.js";

type OrderRow = RowDataPacket & {
  id: string;
  comercio_id: string | null;
  branch_id: string | null;
  vendedor_id: string | null;
  folio: string;
  client_id: string | null;
  cliente_nombre: string;
  status: OrderStatus;
  canal: OrderCanal;
  price_list_id: string | null;
  con_envio: number;
  envio_costo: string | number;
  direccion_envio: string | null;
  telefono_contacto: string | null;
  metodo_pago: PaymentMethod | null;
  created_at: Date | string;
  branch_nombre?: string | null;
  vendedor_nombre?: string | null;
};

type LineRow = RowDataPacket & {
  order_id: string;
  product_id: string;
  nombre: string;
  cantidad: number;
  precio_unitario: string | number;
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function iso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function mapOrder(row: OrderRow, lines: OrderLine[]): Order {
  return {
    id: row.id,
    comercioId: row.comercio_id,
    branchId: row.branch_id,
    vendedorId: row.vendedor_id,
    branchNombre: row.branch_nombre ?? null,
    vendedorNombre: row.vendedor_nombre ?? null,
    folio: row.folio,
    clientId: row.client_id,
    clienteNombre: row.cliente_nombre,
    status: row.status,
    lines,
    createdAt: iso(row.created_at),
    canal: row.canal,
    priceListId: row.price_list_id,
    conEnvio: Boolean(row.con_envio),
    envioCosto: num(row.envio_costo),
    direccionEnvio: row.direccion_envio,
    telefonoContacto: row.telefono_contacto,
    metodoPago: row.metodo_pago,
  };
}

const ORDER_SELECT = `
  SELECT o.*,
         b.nombre AS branch_nombre,
         u.nombre AS vendedor_nombre
  FROM orders o
  LEFT JOIN branches b ON b.id = o.branch_id
  LEFT JOIN users u ON u.id = o.vendedor_id
`;

async function loadLines(orderIds: string[]): Promise<Map<string, OrderLine[]>> {
  const map = new Map<string, OrderLine[]>();
  if (!orderIds.length) return map;
  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await query<LineRow[]>(
    `SELECT order_id, product_id, nombre, cantidad, precio_unitario
     FROM order_lines WHERE order_id IN (${placeholders})
     ORDER BY id ASC`,
    orderIds
  );
  for (const row of rows) {
    const list = map.get(row.order_id) ?? [];
    list.push({
      productId: row.product_id,
      nombre: row.nombre,
      cantidad: row.cantidad,
      precioUnitario: num(row.precio_unitario),
    });
    map.set(row.order_id, list);
  }
  return map;
}

async function nextFolio(
  conn: PoolConnection,
  canal: OrderCanal
): Promise<string> {
  const key =
    canal === "pos"
      ? "folio_pos"
      : canal === "mayorista"
        ? "folio_mayorista"
        : "folio_pedido";
  await conn.execute(
    `INSERT INTO counters (name, value) VALUES (?, 0)
     ON DUPLICATE KEY UPDATE value = value`,
    [key]
  );
  await conn.execute(`UPDATE counters SET value = value + 1 WHERE name = ?`, [
    key,
  ]);
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT value FROM counters WHERE name = ? LIMIT 1`,
    [key]
  );
  const n = Number(rows[0]?.value ?? 1);
  if (canal === "pos") return `POS-${n}`;
  if (canal === "mayorista") return `M-${n}`;
  return `P-${n}`;
}

type PendingDeduction = { productId: string; qty: number };

async function insertOrder(
  conn: PoolConnection,
  order: Omit<Order, "createdAt"> & { createdAt?: string },
  deductStock: boolean
): Promise<PendingDeduction[]> {
  const pending: PendingDeduction[] = [];
  await conn.execute(
    `INSERT INTO orders
     (id, comercio_id, branch_id, vendedor_id, folio, client_id, cliente_nombre, status, canal, price_list_id,
      con_envio, envio_costo, direccion_envio, telefono_contacto, metodo_pago)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.comercioId ?? null,
      order.branchId ?? null,
      order.vendedorId ?? null,
      order.folio,
      order.clientId,
      order.clienteNombre,
      order.status,
      order.canal,
      order.priceListId,
      order.conEnvio ? 1 : 0,
      order.envioCosto,
      order.direccionEnvio,
      order.telefonoContacto,
      order.metodoPago,
    ]
  );
  for (const line of order.lines) {
    await conn.execute(
      `INSERT INTO order_lines
       (order_id, product_id, nombre, cantidad, precio_unitario)
       VALUES (?, ?, ?, ?, ?)`,
      [
        order.id,
        line.productId,
        line.nombre,
        line.cantidad,
        line.precioUnitario,
      ]
    );
    if (deductStock) {
      pending.push({ productId: line.productId, qty: line.cantidad });
    }
  }
  return pending;
}

async function applyDeductions(items: PendingDeduction[]): Promise<void> {
  const { deductStock: deduct } = await import("./comercios.js");
  for (const item of items) {
    await deduct(item.productId, item.qty);
  }
}

export async function listOrders(
  canal?: OrderCanal,
  comercioId?: string,
  branchId?: string | null
): Promise<Order[]> {
  const { getDefaultComercioId } = await import("./comercios.js");
  const cid = comercioId || (await getDefaultComercioId());
  const params: Array<string> = [cid];
  let sql = `${ORDER_SELECT} WHERE o.comercio_id = ?`;
  if (canal) {
    sql += ` AND o.canal = ?`;
    params.push(canal);
  }
  if (branchId) {
    sql += ` AND o.branch_id = ?`;
    params.push(branchId);
  }
  sql += ` ORDER BY o.created_at DESC`;
  const rows = await query<OrderRow[]>(sql, params);
  const lines = await loadLines(rows.map((r) => r.id));
  return rows.map((r) => mapOrder(r, lines.get(r.id) ?? []));
}

export async function getOrder(id: string): Promise<Order | null> {
  const rows = await query<OrderRow[]>(
    `${ORDER_SELECT} WHERE o.id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  const lines = await loadLines([id]);
  return mapOrder(rows[0], lines.get(id) ?? []);
}

function normalizeLines(
  lines: OrderLine[],
  resolveUnit: (line: OrderLine) => number
): OrderLine[] {
  if (!lines.length) throw new HttpError(400, "Agregá líneas al pedido.");
  return lines.map((l) => {
    const cantidad = Math.max(1, Math.floor(Number(l.cantidad) || 1));
    return {
      productId: l.productId,
      nombre: l.nombre,
      cantidad,
      precioUnitario: resolveUnit(l),
    };
  });
}

export async function createPedido(input: {
  clientId: string;
  lines: OrderLine[];
  comercioId?: string;
  branchId?: string | null;
  vendedorId?: string | null;
}): Promise<Order> {
  if (!input.clientId) throw new HttpError(400, "Elegí un cliente.");
  const { getDefaultComercioId } = await import("./comercios.js");
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const client = await getClient(input.clientId);
  if (!client) throw new HttpError(404, "Cliente no encontrado.");
  const listId = await resolveClientPriceListId(client.id, comercioId);

  const products = await Promise.all(
    input.lines.map((l) => getProduct(l.productId))
  );
  const lines = normalizeLines(input.lines, (l) => {
    const p = products.find((x) => x?.id === l.productId);
    return p ? productPrice(p, listId) : l.precioUnitario;
  });
  for (let i = 0; i < lines.length; i++) {
    if (!products[i]) {
      throw new HttpError(400, `Producto ${lines[i].productId} no encontrado.`);
    }
    lines[i].nombre = products[i]!.nombre;
  }

  const id = nextId("o");
  const order = await withTransaction(async (conn) => {
    const folio = await nextFolio(conn, "pedido");
    const draft: Order = {
      id,
      comercioId,
      branchId: input.branchId ?? null,
      vendedorId: input.vendedorId ?? null,
      folio,
      clientId: client.id,
      clienteNombre: client.nombre,
      status: "confirmado",
      lines,
      createdAt: new Date().toISOString(),
      canal: "pedido",
      priceListId: listId,
      conEnvio: false,
      envioCosto: 0,
      direccionEnvio: null,
      telefonoContacto: null,
      metodoPago: null,
    };
    await insertOrder(conn, draft, false);
    return draft;
  });
  return (await getOrder(order.id)) ?? order;
}

export async function createMayoristaPedido(input: {
  clientId: string;
  lines: OrderLine[];
  comercioId?: string;
  branchId?: string | null;
  vendedorId?: string | null;
}): Promise<Order> {
  if (!input.clientId) throw new HttpError(400, "Elegí un cliente.");
  const { getDefaultComercioId } = await import("./comercios.js");
  const { listPriceLists } = await import("./price-lists.js");
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const client = await getClient(input.clientId);
  if (!client) throw new HttpError(404, "Cliente no encontrado.");
  const lists = await listPriceLists(true, comercioId);
  const mayorista =
    lists.find((l) => l.codigo === "mayorista") ??
    lists.find((l) => l.id === PRICE_LIST_MAYORISTA);
  if (!mayorista) throw new HttpError(400, "No hay lista mayorista en este comercio.");
  await ensureActiveList(mayorista.id);

  const products = await Promise.all(
    input.lines.map((l) => getProduct(l.productId))
  );
  const lines = normalizeLines(input.lines, (l) => {
    const p = products.find((x) => x?.id === l.productId);
    return p ? productPrice(p, mayorista.id) : l.precioUnitario;
  });
  for (let i = 0; i < lines.length; i++) {
    if (!products[i]) {
      throw new HttpError(400, `Producto ${lines[i].productId} no encontrado.`);
    }
    lines[i].nombre = products[i]!.nombre;
  }

  const id = nextId("o");
  let pending: PendingDeduction[] = [];
  const order = await withTransaction(async (conn) => {
    const folio = await nextFolio(conn, "mayorista");
    const draft: Order = {
      id,
      comercioId,
      branchId: input.branchId ?? null,
      vendedorId: input.vendedorId ?? null,
      folio,
      clientId: client.id,
      clienteNombre: client.nombre,
      status: "confirmado",
      lines,
      createdAt: new Date().toISOString(),
      canal: "mayorista",
      priceListId: mayorista.id,
      conEnvio: false,
      envioCosto: 0,
      direccionEnvio: null,
      telefonoContacto: null,
      metodoPago: null,
    };
    pending = await insertOrder(conn, draft, true);
    return draft;
  });
  await applyDeductions(pending);
  return (await getOrder(order.id)) ?? order;
}

export async function createPosSale(input: {
  lines: OrderLine[];
  clientId?: string | null;
  priceListId?: string | null;
  conEnvio?: boolean;
  envioCosto?: number;
  direccionEnvio?: string;
  telefonoContacto?: string;
  metodoPago?: PaymentMethod | null;
  comercioId?: string;
  branchId?: string | null;
  vendedorId?: string | null;
}): Promise<Order> {
  if (!input.lines.length) {
    throw new HttpError(400, "Agregá al menos un producto.");
  }
  const metodoPago = input.metodoPago ?? null;
  if (!metodoPago) {
    throw new HttpError(
      400,
      "Elegí método de pago: efectivo o transferencia."
    );
  }

  const { getDefaultComercioId } = await import("./comercios.js");
  const comercioId = input.comercioId || (await getDefaultComercioId());
  const clientId = input.clientId ?? null;
  const client = clientId ? await getClient(clientId) : null;
  if (clientId && !client) throw new HttpError(404, "Cliente no encontrado.");

  let listId =
    input.priceListId ||
    (await resolveClientPriceListId(clientId, comercioId)) ||
    (await getDefaultPriceListId(comercioId));
  const list = await getPriceList(listId);
  if (!list?.activa) listId = await getDefaultPriceListId(comercioId);

  const conEnvio = Boolean(input.conEnvio);
  const envioCosto = conEnvio
    ? Math.max(0, Number(input.envioCosto) || 0)
    : 0;
  const direccionEnvio = conEnvio
    ? (input.direccionEnvio ?? client?.direccion ?? "").trim() || null
    : null;
  const telefonoContacto = conEnvio
    ? (input.telefonoContacto ?? client?.telefono ?? "").trim() || null
    : null;

  if (conEnvio) {
    if (!client && !(input.direccionEnvio ?? "").trim()) {
      throw new HttpError(
        400,
        "Para envío indicá cliente o dirección de entrega."
      );
    }
    if (!direccionEnvio) {
      throw new HttpError(400, "La dirección de envío es obligatoria.");
    }
    if (!telefonoContacto) {
      throw new HttpError(
        400,
        "El teléfono de contacto es obligatorio para envío."
      );
    }
  }

  const products = await Promise.all(
    input.lines.map((l) => getProduct(l.productId))
  );
  const lines = normalizeLines(input.lines, (l) => {
    const p = products.find((x) => x?.id === l.productId);
    return p ? productPrice(p, listId) : l.precioUnitario;
  });
  for (let i = 0; i < lines.length; i++) {
    if (!products[i]) {
      throw new HttpError(400, `Producto ${lines[i].productId} no encontrado.`);
    }
    lines[i].nombre = products[i]!.nombre;
  }

  const id = nextId("o");
  let pending: PendingDeduction[] = [];
  const order = await withTransaction(async (conn) => {
    const folio = await nextFolio(conn, "pos");
    const draft: Order = {
      id,
      comercioId,
      branchId: input.branchId ?? null,
      vendedorId: input.vendedorId ?? null,
      folio,
      clientId: client?.id ?? null,
      clienteNombre: client?.nombre ?? "Mostrador",
      status: conEnvio ? "preparando" : "entregado",
      lines,
      createdAt: new Date().toISOString(),
      canal: "pos",
      priceListId: listId,
      conEnvio,
      envioCosto,
      direccionEnvio,
      telefonoContacto,
      metodoPago,
    };
    pending = await insertOrder(conn, draft, true);
    return draft;
  });
  await applyDeductions(pending);
  return (await getOrder(order.id)) ?? order;
}

function orderAmount(order: Order): number {
  const lines = order.lines.reduce(
    (a, l) => a + l.cantidad * l.precioUnitario,
    0
  );
  return lines + (order.conEnvio ? order.envioCosto : 0);
}

export async function dashboardStats(
  todayIso?: string,
  comercioId?: string,
  branchId?: string | null
): Promise<{
  productos: number;
  clientes: number;
  pedidosAbiertos: number;
  ventasHoy: number;
  stockBajo: number;
  scope: "all" | "branch";
  branchId: string | null;
  ventasPorVendedor: import("../types.js").VendorSalesRow[];
}> {
  const { getDefaultComercioId } = await import("./comercios.js");
  const cid = comercioId || (await getDefaultComercioId());
  const day = todayIso ?? new Date().toISOString().slice(0, 10);
  const branchFilter = branchId ? ` AND o.branch_id = ?` : "";
  const branchParams = branchId ? [branchId] : [];

  const [prod] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM products WHERE activo = 1 AND comercio_id = ?`,
    [cid]
  );
  const [cli] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM clients WHERE comercio_id = ?`,
    [cid]
  );
  const [abiertos] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM orders o
     WHERE o.comercio_id = ? AND o.status IN ('confirmado','preparando')${branchFilter}`,
    [cid, ...branchParams]
  );

  let stockBajo = 0;
  if (branchId) {
    const [stock] = await query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
       FROM product_branch_stock pbs
       INNER JOIN products p ON p.id = pbs.product_id
       WHERE p.activo = 1 AND p.comercio_id = ?
         AND pbs.branch_id = ? AND pbs.stock <= 20`,
      [cid, branchId]
    );
    stockBajo = Number(stock?.n ?? 0);
  } else {
    const [stock] = await query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM products WHERE activo = 1 AND comercio_id = ? AND stock <= 20`,
      [cid]
    );
    stockBajo = Number(stock?.n ?? 0);
  }

  const ordersHoy = await query<OrderRow[]>(
    `${ORDER_SELECT}
     WHERE o.comercio_id = ?
       AND DATE(o.created_at) = ?
       AND o.status NOT IN ('cancelado','borrador')${branchFilter}`,
    [cid, day, ...branchParams]
  );
  const linesMap = await loadLines(ordersHoy.map((o) => o.id));
  let ventasHoy = 0;
  const byVendor = new Map<
    string,
    import("../types.js").VendorSalesRow
  >();
  for (const o of ordersHoy) {
    const mapped = mapOrder(o, linesMap.get(o.id) ?? []);
    const total = orderAmount(mapped);
    ventasHoy += total;
    const key = mapped.vendedorId ?? "__sin__";
    const prev = byVendor.get(key) ?? {
      vendedorId: mapped.vendedorId ?? null,
      vendedorNombre: mapped.vendedorNombre ?? "Sin asignar",
      branchId: mapped.branchId ?? null,
      branchNombre: mapped.branchNombre ?? null,
      tickets: 0,
      total: 0,
    };
    prev.tickets += 1;
    prev.total += total;
    byVendor.set(key, prev);
  }

  return {
    productos: Number(prod?.n ?? 0),
    clientes: Number(cli?.n ?? 0),
    pedidosAbiertos: Number(abiertos?.n ?? 0),
    ventasHoy,
    stockBajo,
    scope: branchId ? "branch" : "all",
    branchId: branchId ?? null,
    ventasPorVendedor: [...byVendor.values()].sort((a, b) => b.total - a.total),
  };
}

export async function salesByVendor(input: {
  comercioId?: string;
  branchId?: string | null;
  from?: string;
  to?: string;
  canal?: OrderCanal;
}): Promise<import("../types.js").VendorSalesRow[]> {
  const { getDefaultComercioId } = await import("./comercios.js");
  const cid = input.comercioId || (await getDefaultComercioId());
  const params: Array<string> = [cid];
  let sql = `${ORDER_SELECT}
    WHERE o.comercio_id = ?
      AND o.status NOT IN ('cancelado','borrador')`;
  if (input.branchId) {
    sql += ` AND o.branch_id = ?`;
    params.push(input.branchId);
  }
  if (input.canal) {
    sql += ` AND o.canal = ?`;
    params.push(input.canal);
  }
  if (input.from) {
    sql += ` AND DATE(o.created_at) >= ?`;
    params.push(input.from);
  }
  if (input.to) {
    sql += ` AND DATE(o.created_at) <= ?`;
    params.push(input.to);
  }
  sql += ` ORDER BY o.created_at DESC`;

  const rows = await query<OrderRow[]>(sql, params);
  const linesMap = await loadLines(rows.map((r) => r.id));
  const byVendor = new Map<string, import("../types.js").VendorSalesRow>();
  for (const o of rows) {
    const mapped = mapOrder(o, linesMap.get(o.id) ?? []);
    const total = orderAmount(mapped);
    const key = `${mapped.vendedorId ?? "__sin__"}::${mapped.branchId ?? "__all__"}`;
    const prev = byVendor.get(key) ?? {
      vendedorId: mapped.vendedorId ?? null,
      vendedorNombre: mapped.vendedorNombre ?? "Sin asignar",
      branchId: mapped.branchId ?? null,
      branchNombre: mapped.branchNombre ?? null,
      tickets: 0,
      total: 0,
    };
    prev.tickets += 1;
    prev.total += total;
    byVendor.set(key, prev);
  }
  return [...byVendor.values()].sort((a, b) => b.total - a.total);
}
