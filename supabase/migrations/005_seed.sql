-- ============================================================
-- 005_seed.sql  –  Datos iniciales
-- IMPORTANTE: Ejecutar DESPUÉS de crear el primer usuario admin
--             en el Supabase Auth Dashboard y actualizar el
--             profile de ese usuario con role='admin'.
-- ============================================================

-- Tienda por defecto
INSERT INTO stores (id, name, slug, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Mi Tienda',
  'mi-tienda',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- SLA rules por defecto
INSERT INTO sla_rules (store_id, classification, max_inaction_hours, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'critical',   2,  true),
  ('00000000-0000-0000-0000-000000000001', 'urgent',     4,  true),
  ('00000000-0000-0000-0000-000000000001', 'claim',      8,  true),
  ('00000000-0000-0000-0000-000000000001', 'follow_up',  24, true)
ON CONFLICT (store_id, classification) DO NOTHING;

-- Patrones de estado EFI (ordenados por prioridad descendente)
INSERT INTO status_patterns
  (pattern, normalized_status, attempt_increment, is_at_risk_trigger, priority)
VALUES
  -- Entregado / devuelto  (mayor prioridad)
  ('entregado',              'delivered',        0, false, 10),
  ('devuelto',               'returned',         0, true,  10),
  ('retornado',              'returned',         0, true,  10),

  -- Intentos explícitos
  ('tercer intento',         'failed_attempt',   0, true,   9),
  ('3er intento',            'failed_attempt',   0, true,   9),
  ('segundo intento',        'failed_attempt',   0, true,   9),
  ('2do intento',            'failed_attempt',   0, true,   9),
  ('primer intento',         'failed_attempt',   0, true,   8),
  ('1er intento',            'failed_attempt',   0, true,   8),

  -- Intentos fallidos genéricos  (suman +1 intento)
  ('no contacto',            'failed_attempt',   1, true,   8),
  ('no localizado',          'failed_attempt',   1, true,   8),
  ('cliente ausente',        'failed_attempt',   1, true,   8),
  ('no fue posible entregar','failed_attempt',   1, true,   8),
  ('intento fallido',        'failed_attempt',   1, true,   8),
  ('no se pudo entregar',    'failed_attempt',   1, true,   8),
  ('visitado',               'failed_attempt',   1, true,   7),
  ('domicilio cerrado',      'failed_attempt',   1, true,   7),
  ('nadie en casa',          'failed_attempt',   1, true,   7),

  -- En ruta / reprogramado
  ('reprogramado',           'out_for_delivery', 0, false,  6),
  ('en ruta',                'out_for_delivery', 0, false,  5),
  ('en camino',              'out_for_delivery', 0, false,  5),
  ('salió a reparto',        'out_for_delivery', 0, false,  5),
  ('con mensajero',          'out_for_delivery', 0, false,  5),

  -- En tránsito
  ('en tránsito',            'in_transit',       0, false,  4),
  ('en transito',            'in_transit',       0, false,  4),
  ('recibido en agencia',    'in_transit',       0, false,  4),
  ('recibido',               'in_transit',       0, false,  3),

  -- Pendiente
  ('procesando',             'pending',          0, false,  2),
  ('pendiente',              'pending',          0, false,  2),
  ('en espera',              'pending',          0, false,  2)
ON CONFLICT DO NOTHING;
