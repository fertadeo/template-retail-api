# Retail local — interfaz

Un único local por instalación. Navegación: Inicio, Productos, Clientes,
Presupuestos, Biblioteca, Pedidos, Mayorista, POS, Reportes, Catálogo público y Configuración.
No hay selector ni administración de comercios, sucursales o canales externos.
El catálogo público del local permite preparar pedidos por WhatsApp. No hay importación por URL ni sincronización con plataformas externas.

Cuenta al pie del sidebar: nombre y rol de la sesión, Mi cuenta con email y
Cerrar sesión. Operador de caja = usuario conectado. En demo se identifica
Demo local y no se simula una sesión real.

Productos: edición manual, precios por lista, stock del local, imágenes, etiquetas
QR/barras y semáforo de datos incompletos. Paginación de 40 y búsqueda en servidor.
POS prioriza código/SKU exacto y mantiene el ticket al cambiar de página.

Biblioteca: 24 medios por página, búsqueda, miniaturas diferidas y original al abrir.
Cantidad y peso registrado abarcan toda la búsqueda; se indica si faltan tamaños.

Configuración: impresora, listas de precios, categorías y centro de cuentas.
Las cuentas de vendedor pueden tener funciones del local, sin asignar sucursales.


## Catálogo público

`/tienda` es público e independiente del back office: búsqueda por nombre/código,
categorías, orden, páginas de 24 y ficha compartible. Imágenes bajo demanda y sin
base64 en listados. Carrito persistente por catálogo; se conserva al cerrar, no
se guardan datos personales de contacto. Controles de cantidad con botones y campo
numérico editable, sin normalizar el borrador durante la escritura.

Carrito, datos de contacto y resultado viven en un modal nativo con foco contenido,
scroll interno, cabecera/pie fijos y acciones claras. El cierre de un formulario
con datos solicita confirmación y se bloquea mientras valida/guarda. La página
explica que solo prepara el mensaje: abrir WhatsApp y tocar Enviar es necesario.
Errores de conexión y cambios de precio/stock no vacían el carrito.

`/catalogo` es privado: publicación, enlace para compartir y pedidos por estado.
Configuración y edición de estado usan modales con confirmación de descarte.
Confirmar un pedido no cobra ni reserva stock; la venta se registra en caja.
Las futuras billeteras tendrán un estado de pago separado, sin botones de cobro
ni proveedores ficticios en esta versión.
