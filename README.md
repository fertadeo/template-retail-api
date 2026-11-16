# template-retail-api — venta local

API Express + MySQL de Aurix Retail para **un local por instalación/DB**.
Compatible con el frontend `fertadeo/template-retail`.

## Funciones

Caja (POS), productos, stock local, clientes, listas de precios, categorías,
pedidos locales/mayoristas, presupuestos, medios, usuarios y reportes.

No registra endpoints de comercios múltiples, sucursales, transferencias ni stock
compartido. Tampoco incluye conectores, sincronización, callbacks de marketplaces,
importación de productos por URL, catálogo público ni pedidos web.
Los servicios de esas integraciones fueron retirados del template.

## Desarrollo y despliegue

Requiere Node >=20.9 y MySQL 8+. Copiar `.env.example` a `.env`, configurar la DB,
instalar con `npm ci` y ejecutar `npm run dev`. API en puerto 3852, prefijo `/api`.
Para producir: `npm run build` y `npm start`; PM2 puede usar `dist/index.js`.
Las migraciones históricas de `sql/` siguen aplicándose al arrancar para conservar
compatibilidad. Esta adaptación no agrega migraciones ni elimina tablas o datos.
No se necesitan credenciales de tiendas externas ni `PUBLIC_BASE_URL`.

## Local, sesión y stock

- `/business` devuelve el único perfil del local (el registro default existente).
  El alcance se resuelve en servidor; headers/query/body de comercio o sucursal
  no cambian el local de las operaciones.
- `POST /auth/login` valida email/contraseña scrypt de una cuenta activa.
  `/auth/session` devuelve la cuenta; `POST /auth/logout` revoca la sesión.
- Cookie HttpOnly `aurix_session`, SameSite=Lax, Secure en producción; 8 horas.
  Sesiones en memoria para un proceso; reiniciar la API exige ingresar de nuevo.
- Solo `/health`, login y logout tienen acceso sin sesión. Se preserva el seed
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
