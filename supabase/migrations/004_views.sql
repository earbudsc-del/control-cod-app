-- ============================================================
-- 004_views.sql  –  Vistas calculadas
-- ============================================================

-- ------------------------------------------------------------
-- agent_performance_summary
-- Métricas de rendimiento por agente, calculadas en tiempo real.
-- Filtrar por fecha desde la aplicación usando agent_actions.created_at
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW agent_performance_summary AS
SELECT
  p.id                                                               AS agent_id,
  p.full_name                                                        AS agent_name,
  p.role,
  p.store_id,

  -- Pedidos asignados (asignación vigente)
  COUNT(DISTINCT o.id) FILTER (WHERE o.assigned_to = p.id)           AS pedidos_asignados,

  -- Acciones de contacto
  COUNT(DISTINCT aa.order_id)
    FILTER (WHERE aa.agent_id = p.id AND aa.action_type = 'contacted')
                                                                     AS pedidos_contactados,
  COUNT(DISTINCT aa.order_id)
    FILTER (WHERE aa.agent_id = p.id AND aa.action_type = 'confirmed')
                                                                     AS pedidos_confirmados,
  COUNT(DISTINCT aa.order_id)
    FILTER (WHERE aa.agent_id = p.id AND aa.action_type = 'rescheduled')
                                                                     AS pedidos_reprogramados,
  COUNT(DISTINCT aa.order_id)
    FILTER (WHERE aa.agent_id = p.id AND aa.action_type = 'recovered')
                                                                     AS pedidos_recuperados,

  -- Resultados finales
  COUNT(DISTINCT o.id)
    FILTER (WHERE o.assigned_to = p.id AND o.follow_up_result = 'delivered')
                                                                     AS pedidos_entregados,
  COUNT(DISTINCT o.id)
    FILTER (WHERE o.assigned_to = p.id AND o.follow_up_result = 'returned')
                                                                     AS pedidos_devueltos,

  -- SLA incumplidos
  COUNT(DISTINCT o.id)
    FILTER (WHERE o.assigned_to = p.id AND o.sla_breached = true)    AS sla_incumplidos,

  -- Reclamos courier
  COUNT(DISTINCT aa.order_id)
    FILTER (WHERE aa.agent_id = p.id AND aa.action_type = 'courier_claim')
                                                                     AS reclamos_courier,

  -- Notas registradas
  COUNT(n.id) FILTER (WHERE n.created_by = p.id)                     AS notas_registradas,

  -- Sin acción >24h (pedidos activos asignados sin movimiento)
  COUNT(DISTINCT o.id) FILTER (
    WHERE o.assigned_to = p.id
      AND o.follow_up_result NOT IN ('delivered','returned')
      AND (
        o.last_action_at IS NULL
        OR o.last_action_at < now() - INTERVAL '24 hours'
      )
  )                                                                   AS sin_accion_24h

FROM profiles p
LEFT JOIN orders         o  ON o.store_id = p.store_id
LEFT JOIN agent_actions  aa ON aa.order_id = o.id
LEFT JOIN notes          n  ON n.order_id  = o.id
GROUP BY p.id, p.full_name, p.role, p.store_id;

-- ------------------------------------------------------------
-- orders_with_sla  –  vista enriquecida para listas y dashboard
-- (incluye tiempo restante de SLA calculado)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW orders_with_sla AS
SELECT
  o.*,
  CASE
    WHEN o.sla_deadline IS NULL THEN 'none'
    WHEN o.sla_breached = true  THEN 'breached'
    WHEN o.sla_deadline - now() < INTERVAL '2 hours' THEN 'warning'
    ELSE 'ok'
  END                                                    AS sla_status,
  EXTRACT(EPOCH FROM (o.sla_deadline - now())) / 3600    AS sla_hours_remaining,
  p.full_name                                            AS assigned_name
FROM orders o
LEFT JOIN profiles p ON p.id = o.assigned_to;
