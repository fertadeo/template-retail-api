import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { env } from "../config/env.js";

/**
 * Aplica sql/*.sql al arrancar (idempotente).
 * Necesario en altas VPS: el provisioner no ejecuta `db:migrate`.
 */
export async function migrateOnBoot(): Promise<void> {
  if (!env.dbEnabled) {
    console.warn("[retail-360-api] skip migrate: DB no configurada");
    return;
  }

  // CWD = raíz del repo en PM2 / npm start; también resolvemos relativos a dist/.
  const candidates = [
    path.join(process.cwd(), "sql"),
    path.resolve(__dirname, "../../sql"),
  ];
  const sqlDir = candidates.find((p) => fs.existsSync(p));
  if (!sqlDir) {
    console.warn("[retail-360-api] skip migrate: no hay carpeta sql/");
    return;
  }
  const conn = await mysql.createConnection({
    host: env.dbHost,
    port: env.dbPort,
    user: env.dbUser,
    password: env.dbPassword,
    multipleStatements: true,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.changeUser({ database: env.dbName });
    const files = fs
      .readdirSync(sqlDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(sqlDir, file), "utf8");
      await conn.query(sql);
    }
    console.log(
      `[retail-360-api] migrate ok (${files.length} files) → ${env.dbName}`
    );
  } finally {
    await conn.end();
  }
}
