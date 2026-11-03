# Guía: traer productos de Mercado Libre

Importá las publicaciones del vendedor a Aurix y cargá el precio en la lista **Mercadolibre** (se crea sola si no existe).

## Requisitos

1. En **Canales → Mercado Libre**:
   - Canal **habilitado**
   - **Access token** válido (`APP_USR-…`)
   - **Seller ID** (si lo dejás vacío, Aurix lo obtiene con `/users/me` al primer pull)
   - **Site ID** típico: `MLA`
2. Comercio activo en el header (destino del import).
3. API remota desplegada con este código.

## Pasos en la UI

1. Abrí **Canales**.
2. En Mercado Libre, opcional: elegí la lista de precios (si está vacío, se usa/crea **Mercadolibre**).
3. Guardá la config.
4. Clic en **Traer de Mercado Libre**.
5. El modal muestra el preview (encontrados / ya coinciden / nuevos). Confirmá.
6. Revisá **Productos**: deberían aparecer con vínculo ML (`MLA…`) y precio en la lista Mercadolibre.

## Qué hace el import

| Campo ML | Destino Aurix |
|----------|----------------|
| SKU (`seller_custom_field` o atributo SKU) o id `MLA…` | `products.sku` |
| título | nombre |
| `price` | precio en lista del canal / Mercadolibre |
| `available_quantity` | stock del comercio |
| `active` / `paused` | activo / inactivo |
| fotos | URLs remotas (como WC) |
| id publicación | vínculo canal `mercadolibre` |

- Solo **active** y **paused**. Las **closed** se omiten.
- Si el SKU ya existe en el comercio → actualiza y vincula.
- Si no → crea producto + vínculo.
- Listado con `search_type=scan` (más de 1000 ítems). Detalle vía **`/items/bulk`** (reemplazo de `/items?ids=`, deprecado).

## Notificaciones (etapa 2 — activa)

1. En el VPS del API seteá `PUBLIC_BASE_URL=https://tu-dominio-api` (sin barra final) y reiniciá.
2. En Canales → bloque **Notificaciones Mercado Libre** copiá la Callback URL.
3. En [Developers](https://developers.mercadolibre.com.ar): pegá esa URL y marcá el tópico **items**.
4. Endpoint: `POST /api/channels/mercadolibre/notifications` → responde **200** al instante y encola.
5. Procesa `items`: GET del MLA… → actualiza stock/precio/activo del producto **ya vinculado**.
6. Log en UI + `GET /api/channels/mercadolibre/notifications`.

Sin vínculo previo el evento queda `skipped` (no crea productos solos; usá el pull).

## Todavía pendiente

- OAuth “Conectar Mercado Libre” (hoy se pega el access token)
- Descripción larga / variantes
- Tópico `orders_v2` (ventas → pedidos Aurix)
- Stock autenticado / user products

## API

```http
POST /channels/mercadolibre/pull
{ "comercioId": "…", "priceListId": null, "dryRun": true }
```

`dryRun: false` escribe. Sin `priceListId` y sin lista en el canal → asegura lista `mercadolibre`.

## Push (después)

Con los vínculos creados, **Push todos** / acción ML en Productos empuja stock/precio desde Aurix hacia ML usando la misma lista del canal.
