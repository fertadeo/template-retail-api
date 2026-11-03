# template-retail-api

Gold **Aurix Retail** (API Express + MySQL). Single-tenant: cada instancia de cliente recibe su propia DB y deploy PM2.

Contrato alineado al store del front `template-retail`.

## Requisitos

- Node ≥ 20
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
