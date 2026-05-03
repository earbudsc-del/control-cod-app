-- ============================================================
-- 003_triggers.sql  –  Triggers automáticos
-- ============================================================

-- ------------------------------------------------------------
-- updated_at en orders
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ------------------------------------------------------------
-- Recalcular SLA deadline cuando cambia classification o assigned_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalculate_sla()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_hours INTEGER;
BEGIN
  IF NEW.classification IS NOT NULL AND NEW.assigned_at IS NOT NULL THEN
    SELECT max_inaction_hours INTO v_hours
    FROM sla_rules
    WHERE classification = NEW.classification
      AND (store_id = NEW.store_id OR store_id IS NULL)
      AND is_active = true
    ORDER BY store_id NULLS LAST
    LIMIT 1;

    IF v_hours IS NOT NULL THEN
      NEW.sla_deadline = NEW.assigned_at + (v_hours || ' hours')::INTERVAL;
    END IF;
  ELSE
    NEW.sla_deadline = NULL;
  END IF;

  -- Evaluar si ya está en breach
  IF NEW.sla_deadline IS NOT NULL
     AND now() > NEW.sla_deadline
     AND NEW.follow_up_result NOT IN ('delivered','returned') THEN
    NEW.sla_breached = true;
  ELSE
    NEW.sla_breached = false;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_sla
  BEFORE INSERT OR UPDATE OF classification, assigned_at, follow_up_result ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_recalculate_sla();

-- ------------------------------------------------------------
-- Auditoría: registrar cambios clave en order_history
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_track_order_changes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_user UUID;
BEGIN
  BEGIN v_user = auth.uid(); EXCEPTION WHEN OTHERS THEN v_user = NULL; END;

  IF OLD.classification IS DISTINCT FROM NEW.classification THEN
    INSERT INTO order_history (order_id, changed_by, field, old_value, new_value)
    VALUES (NEW.id, v_user, 'classification', OLD.classification, NEW.classification);
  END IF;

  IF OLD.normalized_status IS DISTINCT FROM NEW.normalized_status THEN
    INSERT INTO order_history (order_id, changed_by, field, old_value, new_value)
    VALUES (NEW.id, v_user, 'normalized_status', OLD.normalized_status, NEW.normalized_status);
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    INSERT INTO order_history (order_id, changed_by, field, old_value, new_value)
    VALUES (NEW.id, v_user, 'assigned_to', OLD.assigned_to::TEXT, NEW.assigned_to::TEXT);
  END IF;

  IF OLD.follow_up_result IS DISTINCT FROM NEW.follow_up_result THEN
    INSERT INTO order_history (order_id, changed_by, field, old_value, new_value)
    VALUES (NEW.id, v_user, 'follow_up_result', OLD.follow_up_result, NEW.follow_up_result);
  END IF;

  IF OLD.is_at_risk IS DISTINCT FROM NEW.is_at_risk THEN
    INSERT INTO order_history (order_id, changed_by, field, old_value, new_value)
    VALUES (NEW.id, v_user, 'is_at_risk', OLD.is_at_risk::TEXT, NEW.is_at_risk::TEXT);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_history
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_track_order_changes();

-- ------------------------------------------------------------
-- Sincronizar last_contact_at y last_action_at desde agent_actions
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sync_last_contact()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_type = 'contacted' THEN
    UPDATE orders SET
      last_contact_at     = NEW.created_at,
      last_contact_result = NEW.contact_result,
      last_action_at      = NEW.created_at
    WHERE id = NEW.order_id;
  ELSE
    UPDATE orders SET
      last_action_at = NEW.created_at
    WHERE id = NEW.order_id;
  END IF;

  -- Confirmar cliente automáticamente
  IF NEW.action_type = 'confirmed'
     OR NEW.contact_result = 'answered_confirmed' THEN
    UPDATE orders SET
      customer_confirmed    = true,
      customer_confirmed_at = NEW.created_at
    WHERE id = NEW.order_id;
  END IF;

  -- Sincronizar follow_up_result si la acción lo define
  IF NEW.action_type IN ('delivered','returned','recovered') THEN
    UPDATE orders SET
      follow_up_result = NEW.action_type
    WHERE id = NEW.order_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_actions_sync_order
  AFTER INSERT ON agent_actions
  FOR EACH ROW EXECUTE FUNCTION fn_sync_last_contact();

-- ------------------------------------------------------------
-- Sincronizar delivery_attempts desde delivery_attempt_records
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sync_attempts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_valid   INTEGER;
  v_invalid INTEGER;
  v_oid     UUID;
BEGIN
  v_oid = COALESCE(NEW.order_id, OLD.order_id);

  SELECT
    COUNT(*) FILTER (WHERE is_valid = true),
    COUNT(*) FILTER (WHERE is_valid = false)
  INTO v_valid, v_invalid
  FROM delivery_attempt_records
  WHERE order_id = v_oid;

  UPDATE orders SET
    delivery_attempts = v_valid,
    invalid_attempts  = v_invalid
  WHERE id = v_oid;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_attempts_sync
  AFTER INSERT OR UPDATE OR DELETE ON delivery_attempt_records
  FOR EACH ROW EXECUTE FUNCTION fn_sync_attempts();

-- ------------------------------------------------------------
-- Auto-crear profile cuando Supabase Auth crea un usuario
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, role, store_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
    'viewer',
    (SELECT id FROM stores WHERE is_active = true ORDER BY created_at LIMIT 1)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION fn_handle_new_user();
