/** Módulos / funciones asignables a un vendedor. */
export const APP_FUNCTIONS = [
  { code: "dashboard", label: "Inicio" },
  { code: "productos", label: "Productos" },
  { code: "clientes", label: "Clientes" },
  { code: "presupuestos", label: "Presupuestos" },
  { code: "biblioteca", label: "Biblioteca" },
  { code: "pedidos", label: "Pedidos" },
  { code: "mayorista", label: "Mayorista" },
  { code: "pos", label: "POS" },
  { code: "comercios", label: "Comercios" },
  { code: "sucursales", label: "Sucursales" },
  { code: "canales", label: "Canales" },
  { code: "configuracion", label: "Configuración" },
] as const;

export type AppFunctionCode = (typeof APP_FUNCTIONS)[number]["code"];

export const APP_FUNCTION_CODES: AppFunctionCode[] = APP_FUNCTIONS.map(
  (f) => f.code
);

export function isAppFunctionCode(value: string): value is AppFunctionCode {
  return (APP_FUNCTION_CODES as string[]).includes(value);
}
