import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

const loaded = dotenv.config({ path: envPath, override: true, quiet: true });
if (loaded.error) {
  console.warn(`[migrate] no se leyó ${envPath}: ${loaded.error.message}`);
} else {
  const n = Object.keys(loaded.parsed || {}).length;
  if (n === 0) {
    console.warn(
      `[migrate] ${envPath} no tiene variables KEY=value. Se usan defaults (root sin password).`
    );
  } else {
    console.log(`[migrate] ${n} vars desde ${envPath}`);
  }
}

const host = process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || "root";
const password = process.env.DB_PASSWORD || "";
const database = process.env.DB_NAME || "aurix_retail_dev";

async function main() {
  console.log(`Conectando a ${user}@${host}:${port} …`);
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.changeUser({ database });
    const sqlDir = path.join(root, "sql");
    const files = fs
      .readdirSync(sqlDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(sqlDir, file), "utf8");
      await conn.query(sql);
      console.log(`OK — ${file}`);
    }
    console.log(`Schema aplicado en \`${database}\``);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("migrate falló:", err.message || err);
  process.exit(1);
});
