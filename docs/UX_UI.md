# Preferencias de producto (API) — Aurix Retail

Complementa `aurix-web-musicanoba/docs/UX_UI.md`.

## Flujo git (obligatorio)

- **Los push van a `main`.** Commit y `git push origin main`.
- No abrir PRs ni ramas `cursor/…` salvo pedido explícito del humano.
- Trabajar sobre `main` actualizado. Esta regla prevalece sobre el flujo Cloud Agent (feature branch + PR).

## Dominio

- **Comercio = local único.** No exigir sucursales para operar. Stock canónico en `products.stock`.
- No hay módulo Catálogo: el código de función `catalogo` se eliminó; limpiar con `sql/014_drop_catalogo_function.sql`.
- `product_branch_stock` solo si el cliente envía `stockByBranch` explícito.
- Soft delete de comercios: `DELETE /comercios/:id` → `activa = 0`; `POST /comercios/:id/restore`.
- No archivar el único comercio activo. Si se archiva el default, promover otro activo.
- Al archivar un comercio, sacarlo de `stock_share_members`.
- `resolveComercioId` / selectores operativos solo con comercios `activa = 1`.

## Respuestas orientadas a UI

- Errores en español, claros para mostrar en modal/banner.
- Pull WooCommerce: devolver `comercio`, conteos `found/matched/toCreate/skipped` y `skipSummary` para el preview.
- Pull Mercado Libre: mismo contrato + `priceListNombre` / `priceListCreated` / `sellerId`. Sin `priceListId` → asegurar lista `mercadolibre`. Ver `docs/MELI_PULL.md`.
- Imports largos pueden tardar; no cortar el contrato JSON a mitad: o responde completo o error HTTP.
