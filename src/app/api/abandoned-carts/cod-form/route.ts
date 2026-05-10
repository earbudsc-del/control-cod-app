import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse }        from 'next/server'

// ── Autenticación ─────────────────────────────────────────────────────────────
// Este endpoint es llamado desde el frontend del tema Shopify (sin sesión de usuario).
// Se protege con un secret compartido enviado como header X-Cod-Form-Secret.

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface CodFormLeadBody {
  customer_name?:    string
  customer_phone?:   string
  customer_email?:   string
  products_summary?: string
  total_amount?:     number | string
  customer_address?: string
  city?:             string
  province?:         string
  product_id?:       string
  variant_id?:       string
  page_url?:         string
  referrer?:         string
  utm_source?:       string
  utm_campaign?:     string
  utm_content?:      string
  session_id?:       string
  abandoned_at?:     string
}

// ── Helper: normalizar teléfono ───────────────────────────────────────────────

function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null
  return p.replace(/\D/g, '') || null
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // 1. Verificar secret del formulario COD
    const codSecret = process.env.COD_FORM_SECRET
    if (codSecret) {
      const incoming = request.headers.get('x-cod-form-secret')
      if (incoming !== codSecret) {
        console.warn('[cod-form] secret inválido — request rechazado')
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    } else {
      // En desarrollo sin secret configurado se acepta (advertencia en log)
      console.warn('[cod-form] COD_FORM_SECRET no configurado — endpoint sin protección')
    }

    // 2. Variables de entorno
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN
    if (!shopDomain) {
      console.error('[cod-form] SHOPIFY_SHOP_DOMAIN no configurado')
      return NextResponse.json({ error: 'Servidor no configurado' }, { status: 500 })
    }

    // 3. Parsear body
    let body: CodFormLeadBody
    try {
      body = await request.json() as CodFormLeadBody
    } catch {
      return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
    }

    const phone = normalizePhone(body.customer_phone)

    // Validación mínima: necesitamos al menos teléfono o email para que sirva de algo
    if (!phone && !body.customer_email) {
      return NextResponse.json(
        { error: 'Se requiere customer_phone o customer_email' },
        { status: 400 },
      )
    }

    const svc = await createServiceClient()

    // 4. Resolver store_id
    const { data: storeData, error: storeError } = await svc
      .from('stores')
      .select('id')
      .eq('shopify_domain', shopDomain.trim().toLowerCase())
      .single()

    if (storeError || !storeData) {
      console.error('[cod-form] Tienda no encontrada:', shopDomain, storeError?.message)
      return NextResponse.json({ error: 'Tienda no encontrada' }, { status: 404 })
    }
    const storeId = storeData.id

    // 5. Deduplicación
    //    Orden de prioridad:
    //    a) session_id coincide → actualizar ese registro (misma sesión)
    //    b) phone coincide + mismo producto + últimas 24h → actualizar (mismo intento)
    //    c) ninguno → insertar nuevo

    const now      = new Date()
    const ago24h   = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const abandonedAt = body.abandoned_at ?? now.toISOString()

    let existingId: string | null = null

    // (a) Por session_id
    if (body.session_id) {
      const { data: bySess } = await svc
        .from('abandoned_carts')
        .select('id')
        .eq('store_id', storeId)
        .eq('session_id', body.session_id)
        .eq('source', 'cod_form_lead')
        .not('recovery_status', 'in', '(recovered,discarded)')
        .maybeSingle()
      existingId = bySess?.id ?? null
    }

    // (b) Por phone + producto + 24h
    if (!existingId && phone) {
      const { data: byPhone } = await svc
        .from('abandoned_carts')
        .select('id')
        .eq('store_id', storeId)
        .eq('source', 'cod_form_lead')
        .not('recovery_status', 'in', '(recovered,discarded)')
        .gte('abandoned_at', ago24h)
        .or(`customer_phone.eq.${phone},customer_phone.eq.+1${phone},customer_phone.eq.+${phone}`)
        .order('abandoned_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      existingId = byPhone?.id ?? null
    }

    const rowData = {
      store_id:         storeId,
      customer_name:    body.customer_name?.trim()    || null,
      customer_phone:   phone,
      customer_email:   body.customer_email?.trim()   || null,
      products_summary: body.products_summary?.trim() || null,
      total_amount:     body.total_amount != null ? parseFloat(String(body.total_amount)) || null : null,
      currency:         'DOP',
      customer_address: body.customer_address?.trim() || null,
      city:             body.city?.trim()             || null,
      province:         body.province?.trim()         || null,
      product_id:       body.product_id               || null,
      variant_id:       body.variant_id               || null,
      page_url:         body.page_url                 || null,
      referrer:         body.referrer                 || null,
      utm_source:       body.utm_source               || null,
      utm_campaign:     body.utm_campaign             || null,
      utm_content:      body.utm_content              || null,
      session_id:       body.session_id               || null,
      abandoned_at:     abandonedAt,
      source:           'cod_form_lead',
    }

    if (existingId) {
      // Actualizar registro existente (preserva recovery_status y notes)
      const { error: updErr } = await svc
        .from('abandoned_carts')
        .update({ ...rowData, updated_at: now.toISOString() })
        .eq('id', existingId)

      if (updErr) throw updErr

      console.log(`[cod-form] updated existingId=${existingId} phone=${phone ?? '—'} session=${body.session_id ?? '—'}`)
      return NextResponse.json({ ok: true, action: 'updated', id: existingId })
    } else {
      // Insertar nuevo lead
      const { data: inserted, error: insErr } = await svc
        .from('abandoned_carts')
        .insert({ ...rowData, recovery_status: 'pending', recovery_attempts: 0 })
        .select('id')
        .single()

      if (insErr) throw insErr

      console.log(`[cod-form] inserted id=${inserted.id} phone=${phone ?? '—'} product=${body.product_id ?? '—'}`)
      return NextResponse.json({ ok: true, action: 'created', id: inserted.id }, { status: 201 })
    }
  } catch (err) {
    console.error('[POST /api/abandoned-carts/cod-form]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
