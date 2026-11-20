# template-retail-api — venta local

API Express + MySQL de Aurix Retail para **un local por instalación/DB**.
Compatible con el frontend `fertadeo/template-retail`.

## Funciones

Caja (POS), productos, stock local, clientes, listas de precios, categorías,
pedidos locales/mayoristas, presupuestos, medios, usuarios y reportes.

No registra endpoints de comercios múltiples, sucursales, transferencias ni stock
compartido. Tampoco incluye conectores, sincronización, callbacks de marketplaces,
importación de productos por URL. El catálogo público del propio local sí permite
preparar pedidos para WhatsApp, de forma independiente de la caja.
Los servicios de esas integraciones fueron retirados del template.

## Desarrollo y despliegue

Requiere Node >=20.9 y MySQL 8+. Copiar `.env.example` a `.env`, configurar la DB,
instalar con `npm ci` y ejecutar `npm run dev`. API en puerto 3852, prefijo `/api`.
Para producir: `npm run build` y `npm start`; PM2 puede usar `dist/index.js`.
Las migraciones históricas de `sql/` siguen aplicándose al arrancar para conservar
compatibilidad. El catálogo agrega la migración aditiva `018_catalog_checkout.sql`; no elimina tablas ni datos.
No se necesitan credenciales de tiendas externas ni `PUBLIC_BASE_URL`.

## Local, sesión y stock

- `/business` devuelve el único perfil del local (el registro default existente).
  El alcance se resuelve en servidor; headers/query/body de comercio o sucursal
  no cambian el local de las operaciones.
- `POST /auth/login` valida email/contraseña scrypt de una cuenta activa.
  `/auth/session` devuelve la cuenta; `POST /auth/logout` revoca la sesión.
- Cookie HttpOnly `aurix_session`, SameSite=Lax, Secure en producción; 8 horas.
  Sesiones en memoria para un proceso; reiniciar la API exige ingresar de nuevo.
- `/catalog/public` publica únicamente catálogo, imágenes habilitadas y preparación
  de pedidos. `/health`, login y logout también tienen acceso sin sesión. Se preserva el seed
  inicial existente; cambiar la contraseña inicial después del alta.
- El vendedor de una venta/pedido se toma de la sesión, no del cliente HTTP.
  Las nuevas operaciones no asignan sucursal.
- Productos y ventas usan únicamente `products.stock`; no se consultan ni actualizan
  grupos compartidos o espejos por sucursal. La lista de funciones no ofrece los
  módulos retirados. Los campos históricos de compatibilidad no los reactivan.

## Carga eficiente

- `GET /products?page=1&pageSize=40`: limita antes de cargar precios, imágenes,
  categorías y ventas. POS (`pos=true`) prioriza SKU exacto y omite imágenes/ventas.
- `GET /products/counts?q=...&category=...`: contadores de salud independientes;
  cambiar de página no exige recalcularlos. Elegir un filtro de salud sí lo evalúa.
- `GET /media?page=1&pageSize=24&kind=image&q=...`: metadatos y URLs sin base64.
  Contadores incluyen tamaño total registrado y archivos sin peso conocido.
- `/media/:id/content`: originales autenticados; `?thumbnail=1` genera WebP local
  hasta 480×360 con Sharp. Caché de miniaturas acotada a 32 MiB, HTTP privada de
  5 minutos. SVG/no convertibles usan el original; URLs remotas existentes se
  conservan y no se sincronizan.
- `Server-Timing`: servicio, lecturas SQL, espera del pool, cantidad y preparación
  de respuesta. Logs `[catalog-read]` a partir de 500 ms con ruta, estado y bytes;
  sin credenciales ni cuerpos. Los tiempos SQL paralelos se suman.

Desplegar API y frontend de manera coordinada. Instalar dependencias de API para
Sharp. Actualizar templates no modifica automáticamente instancias existentes.
Ver `DEPLOY.md` y `docs/UX_UI.md`.


## Catálogo público del local

Router público montado antes del middleware de sesión; administración de catálogo
montada después. No se reabren comercios múltiples, canales ni callbacks externos.
Publicación apagada por defecto si no existe configuración previa.

- `GET /catalog/public`: nombre/bienvenida, moneda, categorías, disponibilidad de
  WhatsApp y capacidades (canal whatsapp, onlinePayments=false).
- `GET /catalog/public/products?page=1&pageSize=24&q=&category=&sort=name`:
  catálogo paginado. Orden admite name, recent, price_asc y price_desc. Proyección
  explícita: no devuelve costos, datos internos, otras listas ni binarios.
- `GET /catalog/public/products/:id`: ficha y URLs de galería.
- `GET /catalog/public/media/:id?thumbnail=1`: solo imágenes de productos activos
  con stock del local publicado. No expone adjuntos ni la biblioteca privada.
- `POST /catalog/public/cart`: `{ expectedCurrency, items: [{ productId, quantity,
  expectedUnitPrice }] }`. Cantidades enteras 1–99, hasta 30 productos distintos.
  Devuelve precios actuales, total y diferencias por precio, stock o disponibilidad.
- `POST /catalog/public/orders`: mismo carrito más checkoutKey UUID, buyerName,
  buyerPhone internacional y buyerNote. Vuelve a validar, genera referencia y
  whatsappUrl. Un cambio exige revisión (409 con cart); un error de conexión se
  puede reintentar con la misma clave. Precios y moneda siempre se resuelven en
  servidor. La clave única es durable y está acotada al local y payload.

Admin autenticado: `GET/PUT /catalog/settings` y `GET /catalog/orders?page=1&status=…`,
`PATCH /catalog/orders/:id` con status pendiente/confirmado/cancelado. Solo admin y
superadmin configuran/publican; visitante no puede cambiar estados. No se marca
cobrado desde este módulo. Vencido se proyecta automáticamente al consultar.

`retail_settings` conserva los keys de catálogo existentes. Configuración de nombre,
bienvenida, WhatsApp, moneda y vigencia sin secretos de terceros. Publicar exige
WhatsApp internacional válido. La moneda identifica precios; no hace conversión.

La migración 018 añade checkout_key/request_hash y payment_status/payment_method/
payment_reference, con clave única para reintentos. Mantiene filas existentes.
No se confunde el pedido con una venta: no se descuenta/reserva stock, no se
inserta una orden POS, no se escribe whatsapp_sent_at y payment_status comienza
en not_requested. En el futuro un proveedor de pagos deberá verificar sus propios
eventos e idempotencia, y gestionar la venta/refundos; hoy no hay cobros en línea.

El link wa.me prepara un mensaje: el cliente debe enviarlo en WhatsApp. No existe
confirmación automática de envío ni de pago. Hay límites de frecuencia en POSTs,
límites de tamaño y validaciones. Se confía únicamente en un reverse proxy
loopback para obtener req.ip; el proxy debe preservar la cadena X-Forwarded-For.
No se hacen fetches de URLs remotas desde el servidor para renderizar imágenes.

Desplegar de manera coordinada con el frontend (`/tienda` y `/catalogo`). La API
aplica 018 al boot, o con el procedimiento habitual de migraciones. No se ejecutó
MySQL durante esta implementación. Las métricas Server-Timing incluyen el catálogo.
