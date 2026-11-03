-- Purga datos de demo del seed histórico (idempotente / prod-safe).
-- Conserva: listas de precio, sucursales Musicanoba, comercios, canales, usuarios.

-- Pedidos ligados a productos/clientes demo
CREATE TEMPORARY TABLE IF NOT EXISTS tmp_demo_orders AS
SELECT DISTINCT o.id
FROM orders o
LEFT JOIN order_lines ol ON ol.order_id = o.id
WHERE o.client_id IN ('c1', 'c2', 'c3')
   OR ol.product_id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6');

DELETE FROM order_lines WHERE order_id IN (SELECT id FROM tmp_demo_orders);
DELETE FROM orders WHERE id IN (SELECT id FROM tmp_demo_orders);
DROP TEMPORARY TABLE IF EXISTS tmp_demo_orders;

-- Presupuestos ligados a demo
CREATE TEMPORARY TABLE IF NOT EXISTS tmp_demo_quotes AS
SELECT DISTINCT q.id
FROM quotes q
LEFT JOIN quote_lines ql ON ql.quote_id = q.id
WHERE q.client_id IN ('c1', 'c2', 'c3')
   OR q.discount_rule_id = 'dr_volumen'
   OR ql.product_id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6');

DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM tmp_demo_quotes);
DELETE FROM quotes WHERE id IN (SELECT id FROM tmp_demo_quotes);
DROP TEMPORARY TABLE IF EXISTS tmp_demo_quotes;

-- Regla de descuento demo
DELETE FROM discount_rule_tiers WHERE rule_id = 'dr_volumen';
DELETE FROM discount_rules WHERE id = 'dr_volumen';

-- Stock / precios / vínculos de productos demo
DELETE FROM product_channel_links
WHERE product_id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6');

DELETE FROM product_branch_stock
WHERE product_id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6');

DELETE FROM product_prices
WHERE product_id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6');

DELETE FROM products
WHERE id IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6')
   OR sku IN ('BEB-001', 'BEB-014', 'ALI-210', 'ALI-088', 'LIM-003', 'OTR-901');

-- Clientes demo
DELETE FROM clients WHERE id IN ('c1', 'c2', 'c3');
