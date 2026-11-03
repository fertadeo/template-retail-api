import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3852),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://127.0.0.1:3851",
  /** URL pública del API (https://api.midominio.com) para armar el callback de ML. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  dbHost: process.env.DB_HOST?.trim() || "",
  dbPort: Number(process.env.DB_PORT ?? 3306),
  dbUser: process.env.DB_USER?.trim() || "",
  dbPassword: process.env.DB_PASSWORD ?? "",
  dbName: process.env.DB_NAME?.trim() || "aurix_retail_dev",
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 10),
  get dbEnabled(): boolean {
    return Boolean(this.dbHost && this.dbUser && this.dbName);
  },
};
