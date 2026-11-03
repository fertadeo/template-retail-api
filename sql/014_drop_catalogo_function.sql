-- Eliminar módulo Catálogo (vitrina) de permisos de vendedor.
DELETE FROM user_functions WHERE function_code = 'catalogo';
