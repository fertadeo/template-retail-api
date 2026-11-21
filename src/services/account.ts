import type { RowDataPacket } from "mysql2/promise";
import sharp from "sharp";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";

type ProfileRow = RowDataPacket & {
  id: string;
  nombre: string;
  email: string;
  role: string;
  phone: string | null;
  contact_email: string | null;
  has_avatar: number;
  version: string | null;
};
export async function getAccountProfile(id: string) {
  const rows = await query<ProfileRow[]>(
    `SELECT u.id, u.nombre, u.email, u.role, p.phone, p.contact_email,
    (p.avatar IS NOT NULL) AS has_avatar, DATE_FORMAT(p.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS version
    FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.activa = 1 LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "La cuenta no está disponible.");
  return {
    id: row.id,
    nombre: row.nombre,
    email: row.email,
    role: row.role,
    phone: row.phone ?? "",
    contactEmail: row.contact_email ?? "",
    hasAvatar: Boolean(row.has_avatar),
    avatarVersion: row.version,
  };
}
export async function updateAccountProfile(
  id: string,
  input: {
    nombre: string;
    phone: string;
    contactEmail: string;
    avatarDataUrl?: string | null;
  },
) {
  const avatar =
    input.avatarDataUrl === undefined
      ? undefined
      : input.avatarDataUrl === null
        ? null
        : await encodeAvatar(input.avatarDataUrl);
  await withTransaction(async (conn) => {
    await conn.execute(
      "UPDATE users SET nombre = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND activa = 1",
      [input.nombre, id],
    );
    if (avatar === undefined) {
      await conn.execute(
        `INSERT INTO user_profiles (user_id, phone, contact_email) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE phone = VALUES(phone), contact_email = VALUES(contact_email), updated_at = UTC_TIMESTAMP(3)`,
        [id, input.phone, input.contactEmail],
      );
    } else {
      await conn.execute(
        `INSERT INTO user_profiles (user_id, phone, contact_email, avatar) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE phone = VALUES(phone), contact_email = VALUES(contact_email), avatar = VALUES(avatar), updated_at = UTC_TIMESTAMP(3)`,
        [id, input.phone, input.contactEmail, avatar],
      );
    }
  });
  return getAccountProfile(id);
}
async function encodeAvatar(dataUrl: string) {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl,
  );
  if (!match) throw new HttpError(400, "Usá una foto JPG, PNG o WebP.");
  let avatar: Buffer;
  try {
    const source = Buffer.from(match[1], "base64");
    const image = sharp(source, {
      limitInputPixels: 16_000_000,
      failOn: "error",
    });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? ""))
      throw new Error("Unsupported image");
    avatar = await image
      .rotate()
      .resize(512, 512, { fit: "cover", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new HttpError(
      400,
      "No pudimos leer la foto. Elegí otra imagen JPG, PNG o WebP.",
    );
  }
  return avatar;
}
export async function accountAvatar(id: string) {
  const rows = await query<(RowDataPacket & { avatar: Buffer | null })[]>(
    "SELECT avatar FROM user_profiles WHERE user_id = ? LIMIT 1",
    [id],
  );
  if (!rows[0]?.avatar)
    throw new HttpError(404, "Esta cuenta no tiene foto de perfil.");
  return rows[0].avatar;
}
