# template-retail-api

Gold **Aurix Retail** (API Express + MySQL). Single-tenant: cada instancia de cliente recibe su propia DB y deploy PM2.

Contrato alineado al store del front `template-retail`.

## Requisitos

- Node ≥ 20.9
- MySQL 8+

## Setup local

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

API en `http://127.0.0.1:3852` · prefijo `/api`.

Para callback ML: `PUBLIC_BASE_URL=https://{slug}.api.aurixerp.com`.

## Capacidad (respecto al gold base)

- Comercios (soft delete / restore)
- Canales WooCommerce y Mercado Libre (pull, push, notificaciones `items`)
- Media / imágenes de producto
- Presupuestos
- Usuarios y funciones
- Reportes ventas por vendedor
- Sucursales (schema; UX front apagable)

SQL en `sql/` (idempotente al arranque). **No** incluye seeds de un cliente puntual.

Guía ML: `docs/MELI_PULL.md` · UX API: `docs/UX_UI.md`.

## Deploy (provisioner Fenec)

El alta clona este template como `aurix-api-{slug}`, crea DB `aurix_{slug}` e inyecta:

```
PORT, NODE_ENV=production
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
CORS_ORIGIN=https://{slug}.aurixerp.com
PUBLIC_BASE_URL=https://{slug}.api.aurixerp.com
```

Scripts: `npm run build` · `npm start` (aplica `sql/` al arrancar).

## Gold en Fenec Admin

- `repoTemplate`: `fertadeo/template-retail-api`
- `repoTemplateFront`: `fertadeo/template-retail`


### Acceso al sistema

Las rutas privadas de `/api` requieren sesión. `POST /api/auth/login` recibe
`{ "email": "…", "password": "…" }` y valida una cuenta activa de `users` con
su contraseña existente. Devuelve una cookie `aurix_session` HttpOnly, SameSite=Lax,
Secure en producción. `GET /api/auth/session` consulta la sesión y
`POST /api/auth/logout` la revoca.

Las sesiones duran 8 horas y se guardan en memoria para esta instalación de un
solo proceso: reiniciar la API requiere volver a ingresar. Cambiar la contraseña
o desactivar la cuenta invalida sus sesiones. No requiere migraciones ni nuevos
secretos. No se agregan usuarios ni contraseñas predeterminadas.

Siguen públicos el catálogo de `/catalog/public`, health y la recepción/callback
de notificaciones de Mercado Libre. El frontend transmite la cookie por el
proxy del mismo origen `/aurix-api`. Desplegar API y frontend juntos para activar
el login; la API debe quedar disponible antes de usar el frontend actualizado.


### Lecturas de catálogo y biblioteca

- `GET /api/media?page=1&pageSize=24&kind=image&q=...` pagina y filtra en SQL;
  devuelve metadatos, `dataUrl` (URL del original), `thumbnailUrl`, contadores y
  `hasMore`. El listado no selecciona `media_assets.data_url` ni serializa base64.
- Los uploads locales se leen por `GET /api/media/:id/content`; `?thumbnail=1`
  produce WebP de hasta 480×360 con Sharp. Conserva el original para abrir o descargar.
  Miniaturas en memoria con presupuesto de 32 MiB y caché HTTP privada de 5 minutos.
  La cookie de sesión sigue siendo obligatoria. SVG y formatos no convertibles usan
  el original; los medios remotos conservan su URL y no se descargan desde la API.
- Las páginas de productos devuelven URLs de imagen; no incluyen contadores
  globales, stock por sucursal ni grupos compartidos. Precio por lista, ventas de
  la página, categoría y canales se consultan en paralelo. Detalle/edición conserva
  el contrato completo y se obtiene por producto cuando se solicita.
- `GET /api/products/counts?q=...&category=...` obtiene los contadores por separado.
  El frontend los pide al cambiar búsqueda/categoría o guardar; no al cambiar de
  página. Elegir un filtro de salud sigue requiriendo evaluar ese estado en SQL.

Desplegar API y frontend de esta versión de forma coordinada: Next agrega el
rewrite autenticado `/api/media/:path*` hacia el API y navegación de biblioteca.
Ejecutar la instalación habitual `npm ci` del API para incluir Sharp; requiere
Node >=20.9. No se agregan migraciones.

Las respuestas GET de productos y medios incluyen `Server-Timing`: tiempo del
servicio, `read_sql` (suma de lecturas SQL), `read_wait` (espera de conexiones),
`read_queries` (cantidad) y `before_send` (tiempo hasta preparar la respuesta).
Las lecturas paralelas pueden sumar más tiempo SQL que el tiempo total. Respuestas
que duran 500 ms o más generan un registro `[catalog-read]` con ruta, estado,
tiempo, bytes y métricas, sin parámetros SQL, credenciales ni cuerpos de respuesta.
Esto permite comparar la espera del servidor y el peso enviado tras el despliegue.
No representa una medición de latencia de producción hecha durante el desarrollo.
