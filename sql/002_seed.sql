-- Seed operativo (sin productos/clientes/pedidos de demo)

INSERT INTO price_lists (id, nombre, codigo, activa, es_default)
VALUES
  ('pl_minorista', 'Minorista', 'minorista', 1, 1),
  ('pl_mayorista', 'Mayorista', 'mayorista', 1, 0)
ON DUPLICATE KEY UPDATE
  nombre = VALUES(nombre),
  activa = VALUES(activa),
  es_default = VALUES(es_default);

INSERT INTO counters (name, value) VALUES
  ('seq', 0),
  ('folio_pos', 0),
  ('folio_pedido', 0),
  ('folio_mayorista', 0)
ON DUPLICATE KEY UPDATE name = name;
