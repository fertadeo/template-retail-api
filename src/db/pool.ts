import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { env } from "../config/env.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!env.dbEnabled) {
    throw new Error(
      "Base de datos no configurada (DB_HOST / DB_USER / DB_NAME)."
    );
  }
  if (!pool) {
    const limit =
      Number.isFinite(env.dbPoolSize) && env.dbPoolSize > 0
        ? env.dbPoolSize
        : 10;
    pool = mysql.createPool({
      host: env.dbHost,
      port: env.dbPort,
      user: env.dbUser,
      password: env.dbPassword,
      database: env.dbName,
      waitForConnections: true,
      connectionLimit: limit,
      // 0 = sin tope de cola; con N+1 era fácil llegar a 50 y tirar 500.
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      maxIdle: Math.min(4, limit),
      idleTimeout: 60_000,
    });
  }
  return pool;
}

export async function testConnection(): Promise<boolean> {
  if (!env.dbEnabled) return false;
  try {
    const connection = await getPool().getConnection();
    await connection.ping();
    connection.release();
    return true;
  } catch (err) {
    console.error("[retail-360-api] DB connection failed:", err);
    return false;
  }
}

type SqlParam = string | number | boolean | Date | null | Buffer;

export async function query<T extends RowDataPacket[]>(
  sql: string,
  params: SqlParam[] = []
): Promise<T> {
  const [rows] = await getPool().execute<T>(sql, params);
  return rows;
}

export async function execute(
  sql: string,
  params: SqlParam[] = []
): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

export async function withConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
