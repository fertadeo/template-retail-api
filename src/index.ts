import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { migrateOnBoot } from "./db/migrate-boot.js";
import { testConnection } from "./db/pool.js";
import { ensureSeedUsers } from "./services/users.js";

async function main() {
  try {
    await migrateOnBoot();
    await ensureSeedUsers();
  } catch (err) {
    // No matar el proceso: un migrate fallido dejaba nginx en 502.
    // Corregí con `npm run db:migrate` y reiniciá PM2.
    console.error("[retail-360-api] migrate/seed falló (sigo arrancando):", err);
  }

  const app = createApp();
  app.listen(env.port, async () => {
    const dbOk = await testConnection();
    console.log(
      `[retail-360-api] listening on http://127.0.0.1:${env.port} (CORS ${env.corsOrigin}) db=${dbOk ? "ok" : "off"}`
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
