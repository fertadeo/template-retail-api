import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "../db/pool.js";
import { nextId } from "../lib/ids.js";
import { syncLinkedProductFromMeliItem } from "./channels.js";

export type MeliWebhookPayload = {
  _id?: string;
  id?: string;
  resource?: string;
  user_id?: number | string;
  topic?: string;
  application_id?: number | string;
  attempts?: number;
  sent?: string;
  received?: string;
};

export type MeliNotificationEvent = {
  id: string;
  meliEventId: string | null;
  topic: string;
  resource: string;
  userId: string | null;
  applicationId: string | null;
  attempts: number;
  status: "queued" | "processing" | "done" | "skipped" | "error";
  resultMessage: string | null;
  productId: string | null;
  receivedAt: string;
  processedAt: string | null;
};

type EventRow = RowDataPacket & {
  id: string;
  meli_event_id: string | null;
  topic: string;
  resource: string;
  user_id: string | null;
  application_id: string | null;
  attempts: number;
  status: MeliNotificationEvent["status"];
  result_message: string | null;
  product_id: string | null;
  received_at: Date | string;
  processed_at: Date | string | null;
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapEvent(row: EventRow): MeliNotificationEvent {
  return {
    id: row.id,
    meliEventId: row.meli_event_id,
    topic: row.topic,
    resource: row.resource,
    userId: row.user_id,
    applicationId: row.application_id,
    attempts: row.attempts,
    status: row.status,
    resultMessage: row.result_message,
    productId: row.product_id,
    receivedAt: iso(row.received_at)!,
    processedAt: iso(row.processed_at),
  };
}

function extractItemId(resource: string): string | null {
  const m = resource.trim().match(/\/items\/([A-Z]{3}\d+)/i);
  return m?.[1]?.toUpperCase() ?? null;
}

/**
 * Encola la notificación y responde al caller; el proceso corre en background.
 * Debe ser barato: ML exige HTTP 200 en < ~500ms.
 */
export async function enqueueMeliNotification(
  payload: MeliWebhookPayload
): Promise<{ accepted: boolean; id: string; duplicate?: boolean }> {
  const topic = String(payload.topic ?? "").trim() || "unknown";
  const resource = String(payload.resource ?? "").trim() || "/";
  const meliEventId = String(payload._id ?? payload.id ?? "").trim() || null;
  const id = nextId("mn");

  if (meliEventId) {
    const existing = await query<EventRow[]>(
      `SELECT id FROM meli_notification_events WHERE meli_event_id = ? LIMIT 1`,
      [meliEventId]
    );
    if (existing[0]) {
      return { accepted: true, id: existing[0].id, duplicate: true };
    }
  }

  try {
    await execute(
      `INSERT INTO meli_notification_events
         (id, meli_event_id, topic, resource, user_id, application_id, attempts, payload_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [
        id,
        meliEventId,
        topic.slice(0, 64),
        resource.slice(0, 255),
        payload.user_id != null ? String(payload.user_id).slice(0, 64) : null,
        payload.application_id != null
          ? String(payload.application_id).slice(0, 64)
          : null,
        Math.max(1, Number(payload.attempts) || 1),
        JSON.stringify(payload).slice(0, 8000),
      ]
    );
  } catch (err) {
    // Carrera en unique meli_event_id
    const msg = err instanceof Error ? err.message : "";
    if (meliEventId && /duplicate/i.test(msg)) {
      return { accepted: true, id, duplicate: true };
    }
    throw err;
  }

  setImmediate(() => {
    void processMeliNotification(id).catch((e) => {
      console.error("[meli-notif] process failed", id, e);
    });
  });

  return { accepted: true, id };
}

export async function processMeliNotification(eventId: string): Promise<void> {
  const rows = await query<EventRow[]>(
    `SELECT * FROM meli_notification_events WHERE id = ? LIMIT 1`,
    [eventId]
  );
  const row = rows[0];
  if (!row) return;
  if (row.status === "done" || row.status === "skipped") return;

  await execute(
    `UPDATE meli_notification_events SET status = 'processing' WHERE id = ?`,
    [eventId]
  );

  try {
    const topic = row.topic.toLowerCase();
    if (topic === "items" || topic === "items_prices" || topic === "prices") {
      const itemId = extractItemId(row.resource);
      if (!itemId) {
        await finish(eventId, "skipped", "Resource de ítem no parseable.", null);
        return;
      }
      const result = await syncLinkedProductFromMeliItem(itemId);
      await finish(
        eventId,
        result.skipped ? "skipped" : result.ok ? "done" : "error",
        result.message.slice(0, 500),
        result.productId ?? null
      );
      return;
    }

    await finish(
      eventId,
      "skipped",
      `Tópico «${row.topic}» recibido; aún no se procesa (próxima etapa: orders).`,
      null
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error al procesar";
    await finish(eventId, "error", msg.slice(0, 500), null);
  }
}

async function finish(
  id: string,
  status: "done" | "skipped" | "error",
  message: string,
  productId: string | null
): Promise<void> {
  await execute(
    `UPDATE meli_notification_events
     SET status = ?, result_message = ?, product_id = ?, processed_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [status, message, productId, id]
  );
}

export async function listMeliNotifications(
  limit = 40
): Promise<MeliNotificationEvent[]> {
  const n = Math.max(1, Math.min(limit, 100));
  const rows = await query<EventRow[]>(
    `SELECT * FROM meli_notification_events
     ORDER BY received_at DESC
     LIMIT ${n}`
  );
  return rows.map(mapEvent);
}

export function meliNotificationsCallbackPath(): string {
  return "/api/channels/mercadolibre/notifications";
}
