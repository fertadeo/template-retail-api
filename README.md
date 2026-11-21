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

Desplegar de manera coordinada con el frontend (`/tienda`, Configuración y Pedidos). La API
aplica 018 al boot, o con el procedimiento habitual de migraciones. No se ejecutó
MySQL durante esta implementación. Las métricas Server-Timing incluyen el catálogo.

Las listas públicas priorizan productos con imagen antes de paginar, conservando
el orden elegido dentro de cada grupo. Los pedidos admiten pendiente → en_preparacion
→ listo_para_entrega → entregado → devolucion; pueden cancelarse antes de entregarse.
Listo para entrega también puede volver a preparación. El vencimiento del enlace
de WhatsApp no cancela ni oculta solicitudes pendientes. Estados históricos
confirmado/vencido se leen como en_preparacion/pendiente sin reescribir filas.
No se requiere una nueva migración para estos estados (columna VARCHAR existente).


## Mi cuenta y Ver como

`GET /api/auth/profile` devuelve solo el perfil de la sesión efectiva. `PATCH`
en la misma URL permite editar nombre, teléfono y email de contacto (no cambia
el email de login). Un `avatarDataUrl` JPG/PNG/WebP opcional se valida y convierte
a WebP de hasta 512 px; `null` lo elimina. El guardado de datos y foto es atómico.
`GET /api/auth/profile/avatar` entrega la foto de la sesión autenticada con caché
privada deshabilitada. No acepta un usuario destino ni expone fotos públicamente.
Los blobs viven en user_profiles, separados de los listados de usuarios.

`PUT /api/auth/password` requiere currentPassword y newPassword (8–128 caracteres).
Siempre modifica la cuenta autenticada: ignora cualquier id externo. Verifica la
contraseña actual, limita intentos y compara el hash anterior al actualizar para
no pisar un cambio concurrente. Cierra todas las sesiones previas de esa cuenta
y renueva el token del navegador que realizó el cambio.

`POST /api/auth/view-as` acepta userId desde superadmin o administrador; el administrador solo puede consultar vendedores.
Conserva la identidad y el hash del superadmin; no usa ni verifica la contraseña
del usuario consultado. `/api/auth/session` devuelve el usuario efectivo y actor
cuando hay una vista activa. El middleware bloquea todas las escrituras privadas
durante esa vista, salvo los controles de vista y logout. `POST /api/auth/view-as/stop`
restaura la identidad original. Cambiar la contraseña del vendedor no interrumpe
la consulta; revocar las credenciales del superadmin sí revoca su sesión de vista.
Si el destino se desactiva, la vista permanece bloqueada hasta salir.

Las escrituras de /users requieren administrador o superadmin; un administrador
puede crear vendedores, visitantes y administradores; solo puede editar/desactivar
cuentas existentes de vendedores/visitantes. Un vendedor no puede elevar su rol
ni modificar cuentas ajenas desde la API; su perfil se edita por /auth/profile.

Desplegar con la migración aditiva `019_user_profiles.sql` y el frontend compatible.
No se ejecuta MySQL durante la validación: `npm run test:account` compila y ejecuta
pruebas aisladas con persistencia simulada para cambios de contraseña, revocación,
separación de identidades y modo de consulta sin escrituras.

Los administradores pueden crear usuarios con roles vendedor, visitante y administrador
mediante POST /api/users. Crear superadmins y modificar cuentas de administración
existentes sigue reservado al superadmin. No requiere migraciones.


### Primer acceso (migración 021)

users.must_change_password indica que la contraseña es temporal. Las nuevas altas,
el usuario inicial de instalaciones nuevas y los restablecimientos administrativos
la dejan en 1. changeOwnPassword verifica la contraseña temporal, renueva la sesión
y la pone en 0 de forma atómica junto con el hash. La migración agrega la bandera
sin imponer cambios a cuentas existentes y establece el default de futuras altas.

Una sesión con cambio pendiente solo puede consultar /auth/session, cambiar su
contraseña, cerrar sesión o salir de una vista. Las demás rutas privadas devuelven
403 con code=PASSWORD_CHANGE_REQUIRED, incluidas lecturas. En Ver como la obligación
se evalúa sobre el actor real; el vendedor puede tener un cambio pendiente sin
bloquear la consulta de superadmin/administrador. El administrador solo puede
consultar vendedores; la API vuelve a validar ese rol en cada petición.
Las pruebas de test:account cubren el bloqueo previo, persistencia del requisito,
renovación, acceso posterior y vista administrativa independiente de credenciales.
No se ejecutó MySQL. Desplegar la migración 021 junto con el frontend compatible.


## Caja compartida por comercio (migración 022)

GET /api/cash/current entrega la apertura y su resumen. POST /open registra el
monto inicial y usuario de sesión; índice único open_comercio_id y bloqueo de
comercio evitan aperturas paralelas. POST /:id/close requiere contado, versión y
observación y solo admite al abridor o administrador. Bloquea la fila, comprueba
que no entraron ventas nuevas y persiste el cierre y sus importes. GET /history
pagina cierres; GET /daily-sales?from=YYYY-MM-DD&to=YYYY-MM-DD agrega ventas POS
por día y moneda sin traer pedidos/líneas completos al cliente.

El POS exige una apertura bloqueada FOR UPDATE en la transacción de la venta y
asigna orders.cash_session_id. La versión avanza con cada venta, de modo que un
cierre concurrente exige revisar el resumen. Se conserva el mecanismo existente
de descuento de stock. No se permiten visitantes cobrando ni operadores elegidos
por headers/body: el vendedor registrado es el usuario real autenticado. La caja
es compartida y admite varios turnos por día. No hay movimientos de retiros o
refuerzos; cualquier diferencia se registra al cierre con observación.

Efectivo esperado = monto inicial + ventas POS en efectivo (incluido envío).
Transferencias se totalizan por separado. Pedidos de catálogo, borradores y
cancelaciones no se contabilizan como cobros. Históricos sin método de pago se
muestran sin clasificar. Cada apertura guarda su moneda; el reporte no mezcla
monedas al agrupar. Las aperturas anteriores no se inventan para ventas históricas.

El día comercial usa RETAIL_UTC_OFFSET_MINUTES=-180 (Argentina) por defecto.
Rangos usan límites UTC indexables y máximo 366 días; las nuevas órdenes usan
UTC_TIMESTAMP. Se interpretan los timestamps históricos como UTC sin reescribirlos.
Si una instalación anterior guardó horas locales, requiere normalizarlas antes
para comparar su historia con las nuevas fechas comerciales.

La migración 022 agrega tablas, asociación e índices sin borrar órdenes. No se
ha ejecutado MySQL. npm run build && node --test tests/cash-register.test.cjs
verifica importes, corte de día, caja cerrada y permisos/versión de cierre con
persistencia simulada. Desplegar junto con frontend y las migraciones habituales.

## Colecciones editoriales del inicio (migración 020)

`/api/catalog/collections` es privado y solo admite administradores/superadmins;
hereda el bloqueo de escrituras de Ver como. GET lista metadatos sin blobs;
GET /:id devuelve el borrador con IDs seleccionados; POST y PUT /:id guardan
con baseRevision y action draft/publish. POST /:id/publish y /:id/pause requieren
la revisión actual. Las lecturas y escrituras se acotan al comercio autenticado.
El título, encuadre, posición, imagen y membresía publicados son una copia separada
del borrador; se publican en una transacción y la edición posterior no los altera.
Para activar se exige título, portada y al menos un producto públicamente disponible.

GET /products dentro de ese prefijo pagina metadatos de 24 productos con búsqueda
por nombre/SKU o hasta 24 IDs. GET /product-ids devuelve solo IDs (máximo 2000)
para selección masiva sin cargar fichas o imágenes. Las selecciones se validan por
comercio y se insertan por lotes de 200; máximo 50 colecciones por comercio.
Los IDs seleccionados y sus posiciones se guardan en etapas draft/published.

La información pública `/api/catalog/public` incluye solo colecciones activas con
portada publicada y productos disponibles. `/api/catalog/public/products` acepta
collection y sort=featured para el orden editorial; siempre aplica los filtros
públicos de stock/precio/categoría y prioriza productos con foto. Ningún borrador
se devuelve desde estas rutas. `/api/catalog/public/collections/:id/image` solo
sirve la imagen publicada de una colección visible del comercio publicado;
small=1 usa una variante WebP de hasta 640 px. La versión normal tiene hasta 1600 px.
Las portadas privadas requieren sesión y los listados nunca incluyen datos binarios.

La migración aditiva 020 crea tablas nuevas sin reclasificar productos ni tocar
pedidos, precios o stock. Desplegar coordinadamente con el frontend y el mecanismo
habitual de migraciones al arrancar. No se ejecutó MySQL en esta implementación.
`npm run build && node --test tests/store-collections.test.cjs` verifica borradores,
activación, rollback por publicación inválida, aislamiento por comercio y revisiones
con persistencia simulada, sin conectarse a una base de datos.


## Publicación de tienda y colecciones

La API ofrece catálogo público paginado, búsqueda y filtros, fotos públicas solo de productos visibles, detalle/galería, revisión de carrito y checkout idempotente por clave. Cada pedido conserva precios y datos del comprador y aparece en la administración con los seis estados de preparación/entrega.

Las colecciones tienen borrador y versión publicada independientes, portada procesada con Sharp, selección paginada de productos, orden, activación y pausa. Solo administradores y superadministradores pueden diseñar/publicar; el modo “Ver como” es de solo lectura.

Aplicar las migraciones SQL antes de servir el frontend. `020_store_collections.sql` agrega colecciones sin publicar automáticamente ninguna. Se validaron compilación y pruebas aisladas de colecciones/autenticación; no se ejecutó MySQL ni se desplegó el servicio.
