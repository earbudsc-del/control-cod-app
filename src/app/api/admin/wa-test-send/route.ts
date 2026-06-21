import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { normalizePhoneRD } from '@/lib/normalize-phone'

// POST /api/admin/wa-test-send
// Envío individual del template order_confirmation_cod a un teléfono de prueba,
// sin tocar wa_template_queue ni procesar la cola. Solo admin.
//
// Reutiliza exactamente el mismo template/componentes que el cron
// (src/app/api/cron/wa-template-queue/route.ts), pero con destino explícito
// en el body en lugar del teléfono real del cliente — para validar el flujo
// completo (template → botón → webhook → applyConfirmationAction) sin
// arriesgar enviar a un cliente real.

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

function makePreview(text: string): string {
  return text.length > 150 ? text.slice(0, 150) + '…' : text
}

export async function POST(request: Request) {
  try {
    // ── Auth: solo admin ─────────────────────────────────────────────────────
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admin puede enviar templates de prueba' }, { status: 403 })
    }

    const body     = await request.json() as { phone?: unknown; order_id?: unknown }
    const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : ''
    const orderId  = typeof body.order_id === 'string' ? body.order_id.trim() : ''

    if (!phoneRaw) return NextResponse.json({ error: 'El campo phone es requerido' }, { status: 422 })
    if (!orderId)  return NextResponse.json({ error: 'El campo order_id es requerido' }, { status: 422 })

    const phoneNormalized = normalizePhoneRD(phoneRaw)
    if (phoneNormalized.length < 10) {
      return NextResponse.json({ error: 'Número de teléfono inválido' }, { status: 422 })
    }

    // Service client para las operaciones DB (evita bloqueos RLS — mismo patrón que dispatch-local)
    const supabase = await createServiceClient()

    // ── Pedido: debe existir y pertenecer a la tienda del admin ──────────────
    const { data: order } = await supabase
      .from('orders')
      .select('id, store_id, customer_name, product_summary, cod_amount')
      .eq('id', orderId)
      .maybeSingle()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    if (order.store_id !== profile.store_id) {
      return NextResponse.json({ error: 'Sin acceso a este pedido' }, { status: 403 })
    }

    const customerName   = (order.customer_name as string | null)   ?? 'Cliente'
    const productSummary = (order.product_summary as string | null) ?? ''
    const codAmount       = String(order.cod_amount ?? '0')

    // ── wa_contact: find-or-create, vincula order_id de forma explícita ──────
    // (a diferencia del webhook, que solo vincula si estaba vacío — aquí es
    // un envío de prueba deliberado, siempre apunta al order_id pedido).
    const contactId = await resolveTestContact(supabase, order.store_id, phoneNormalized, customerName, orderId)

    // ── wa_conversation: find-or-create abierta ───────────────────────────────
    const conversationId = await resolveOpenConversation(supabase, order.store_id, contactId)

    // ── Envío directo via Meta — un solo destinatario, fuera de la cola ──────
    const WA_API_VERSION                  = process.env.WA_API_VERSION!
    const WA_PHONE_NUMBER_ID              = process.env.WA_PHONE_NUMBER_ID!
    const WA_ACCESS_TOKEN                 = process.env.WA_ACCESS_TOKEN!
    const WA_ORDER_CONFIRMATION_IMAGE_URL = process.env.WA_ORDER_CONFIRMATION_IMAGE_URL!

    const metaRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNormalized,
          type: 'template',
          template: {
            name: 'order_confirmation_cod',
            language: { code: 'es' },
            components: [
              {
                type: 'header',
                parameters: [
                  { type: 'image', image: { link: WA_ORDER_CONFIRMATION_IMAGE_URL } },
                ],
              },
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: customerName },
                  { type: 'text', text: productSummary },
                  { type: 'text', text: codAmount },
                ],
              },
            ],
          },
        }),
      },
    )

    if (!metaRes.ok) {
      const metaErr = await metaRes.text()
      console.error('[wa-test-send] Meta error', metaRes.status, metaErr)
      return NextResponse.json({ error: 'Error al enviar template via Meta', detail: metaErr }, { status: 502 })
    }

    const metaData = await metaRes.json() as { messages?: { id: string }[] }
    const wamid = metaData.messages?.[0]?.id
    if (!wamid) {
      console.error('[wa-test-send] Meta OK sin wamid', metaData)
      return NextResponse.json({ error: 'Meta respondió OK pero no devolvió el ID del mensaje' }, { status: 502 })
    }

    const sentAt = new Date().toISOString()
    const templateBody = `👋 ¡Hola, ${customerName}!\n\nTu pedido de ${productSummary} ya está listo para envío.\n\n💰 RD$ ${codAmount}\n🚚 Entrega: 1–3 días laborables\n\n🎁 Tu oferta está reservada.\nPulsa Confirmar o No, gracias.`

    // ── wa_message outbound — metadata completa para que se vea igual que un envío real en Inbox
    const { error: insertErr } = await supabase.from('wa_messages').insert({
      store_id:        order.store_id,
      conversation_id: conversationId,
      wa_msg_id:       wamid,
      direction:       'outbound',
      message_type:    'template',
      body:            templateBody,
      status:          'sent',
      sent_at:         sentAt,
      sent_by:         user.id,
      metadata: {
        order_id:         orderId,
        template_name:    'order_confirmation_cod',
        customer_name:    customerName,
        product_summary:  productSummary,
        cod_amount:       codAmount,
        header_image_url: WA_ORDER_CONFIRMATION_IMAGE_URL,
        language:         'es',
        buttons:          ['Confirmar', 'No, gracias'],
        test_send:        true,
        test_order_id:    orderId,
      },
    })

    if (insertErr) {
      console.error('[wa-test-send] Template enviado por Meta pero falló el insert en wa_messages', insertErr)
      return NextResponse.json({
        error:  'Template enviado pero falló el registro en Inbox',
        detail: insertErr.message,
        wa_msg_id: wamid,
      }, { status: 500 })
    }

    await supabase
      .from('wa_conversations')
      .update({
        last_message_at:      sentAt,
        last_message_preview: makePreview(templateBody),
      })
      .eq('id', conversationId)

    console.log(`[wa-test-send] order=${orderId} phone=${phoneNormalized} wamid=${wamid} by=${user.id}`)

    return NextResponse.json({
      success:         true,
      wa_msg_id:       wamid,
      conversation_id: conversationId,
      contact_id:      contactId,
      order_id:        orderId,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/admin/wa-test-send]', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: 'Error interno', detail: msg }, { status: 500 })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveTestContact(
  supabase:        ServiceClient,
  storeId:         string,
  phoneNormalized: string,
  displayName:     string,
  orderId:         string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('wa_contacts')
    .select('id')
    .eq('store_id', storeId)
    .eq('phone_normalized', phoneNormalized)
    .maybeSingle()

  if (existing) {
    // TEST ONLY — sobreescribe order_id incondicionalmente. El webhook real
    // (processInboundMessage) NUNCA hace esto: solo vincula si order_id es
    // null. Aquí es intencional porque cada request de prueba debe apuntar
    // al order_id indicado explícitamente en el body, sin importar el
    // historial previo del contacto de prueba.
    await supabase
      .from('wa_contacts')
      .update({
        order_id:     orderId,
        display_name: displayName,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    return existing.id
  }

  const { data: created, error } = await supabase
    .from('wa_contacts')
    .insert({
      store_id:         storeId,
      phone_normalized: phoneNormalized,
      display_name:     displayName,
      order_id:         orderId,
      last_seen_at:     new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    // Race condition entre dos requests simultáneos — releer (mismo patrón que el webhook)
    if (error.code === '23505') {
      const { data: refetched } = await supabase
        .from('wa_contacts')
        .select('id')
        .eq('store_id', storeId)
        .eq('phone_normalized', phoneNormalized)
        .single()
      if (refetched) return refetched.id
    }
    throw error
  }

  return created.id
}

async function resolveOpenConversation(
  supabase:  ServiceClient,
  storeId:   string,
  contactId: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('wa_conversations')
    .select('id')
    .eq('contact_id', contactId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('wa_conversations')
    .insert({ store_id: storeId, contact_id: contactId, status: 'open', unread_count: 0 })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      const { data: refetched } = await supabase
        .from('wa_conversations')
        .select('id')
        .eq('contact_id', contactId)
        .neq('status', 'closed')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
      if (refetched) return refetched.id
    }
    throw error
  }

  return created.id
}
