import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { SD_LOCATION_REQUEST_TEMPLATE_NAME } from '@/lib/deliveries/sd-location-request'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

type Job = {
  id: string
  store_id: string
  order_id: string
  template_name: string
  phone_normalized: string
  created_at: string
  attempt_count: number
}

function makePreview(text: string): string {
  return text.length > 150 ? text.slice(0, 150) + '…' : text
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createServiceClient()

  const { data: jobs, error: fetchError } = await supabase
    .from('wa_template_queue')
    .select('id, store_id, order_id, template_name, phone_normalized, created_at, attempt_count')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (fetchError) {
    console.error('[cron/wa-template-queue] fetch error', fetchError)
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ processed: 0, sent: 0, skipped: 0, failed: 0 })
  }

  let sent = 0, skipped = 0, failed = 0
  for (const job of jobs) {
    const result = await processJob(supabase, job as Job)
    if (result === 'sent') sent++
    else if (result === 'skipped') skipped++
    else if (result === 'failed') failed++
  }

  return NextResponse.json({ processed: jobs.length, sent, skipped, failed })
}

// Dispatcher — reclama el job atómicamente (evita doble procesamiento entre
// invocaciones concurrentes del cron) y delega a la lógica específica de
// cada template_name. UNIQUE(order_id, template_name) en wa_template_queue
// ya garantiza que nunca hay dos jobs pendientes para el mismo (pedido,
// template); este claim atómico garantiza que un mismo job no se procesa
// dos veces si el cron se dispara solapado.
async function processJob(
  supabase: ServiceClient,
  job: Job,
): Promise<'sent' | 'skipped' | 'failed' | 'unclaimed'> {
  const nowStr = new Date().toISOString()

  const { data: claimed } = await supabase
    .from('wa_template_queue')
    .update({
      status: 'processing',
      attempt_count: job.attempt_count + 1,
      last_attempted_at: nowStr,
    })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (!claimed) return 'unclaimed'

  if (job.template_name === SD_LOCATION_REQUEST_TEMPLATE_NAME) {
    return runSdLocationRequestJob(supabase, job, nowStr)
  }
  return runOrderConfirmationJob(supabase, job, nowStr)
}

// ── Template histórico: order_confirmation_cod (FASE 6A, sin cambios de comportamiento) ──
async function runOrderConfirmationJob(
  supabase: ServiceClient,
  job: Job,
  nowStr: string,
): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    // Check if client wrote inbound after the order was placed
    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('store_id', job.store_id)
      .eq('phone_normalized', job.phone_normalized)
      .maybeSingle()

    if (contact) {
      const { data: convs } = await supabase
        .from('wa_conversations')
        .select('id')
        .eq('contact_id', contact.id)

      if (convs && convs.length > 0) {
        const convIds = convs.map((c: { id: string }) => c.id)
        const { count } = await supabase
          .from('wa_messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .eq('direction', 'inbound')
          .gt('sent_at', job.created_at)

        if ((count ?? 0) > 0) {
          await supabase
            .from('wa_template_queue')
            .update({ status: 'skipped', skip_reason: 'client_already_wrote', processed_at: nowStr })
            .eq('id', job.id)
          return 'skipped'
        }
      }
    }

    // Fetch order data for template variables
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('customer_name, product_summary, cod_amount')
      .eq('id', job.order_id)
      .maybeSingle()

    if (orderError || !order) {
      throw new Error(`Order not found: ${job.order_id}`)
    }

    const customerName = (order.customer_name as string | null) ?? 'Cliente'
    const productSummary = (order.product_summary as string | null) ?? ''
    const codAmount = String(order.cod_amount ?? '0')

    // Find or create wa_contact
    let contactId: string

    const { data: existingContact } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('store_id', job.store_id)
      .eq('phone_normalized', job.phone_normalized)
      .maybeSingle()

    if (existingContact) {
      contactId = (existingContact as { id: string }).id
    } else {
      const { data: newContact, error: contactError } = await supabase
        .from('wa_contacts')
        .insert({
          store_id: job.store_id,
          phone_normalized: job.phone_normalized,
          display_name: customerName,
          order_id: job.order_id,
        })
        .select('id')
        .single()

      if (contactError) {
        // Race condition: another worker inserted simultaneously
        if ((contactError as { code?: string }).code === '23505') {
          const { data: refetched } = await supabase
            .from('wa_contacts')
            .select('id')
            .eq('store_id', job.store_id)
            .eq('phone_normalized', job.phone_normalized)
            .maybeSingle()
          if (!refetched) throw new Error('Contact insert conflict, refetch failed')
          contactId = (refetched as { id: string }).id
        } else {
          throw contactError
        }
      } else {
        contactId = (newContact as { id: string }).id
      }
    }

    // Find open conversation or create one
    let conversationId: string

    const { data: existingConv } = await supabase
      .from('wa_conversations')
      .select('id')
      .eq('contact_id', contactId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingConv) {
      conversationId = (existingConv as { id: string }).id
    } else {
      const { data: newConv, error: convError } = await supabase
        .from('wa_conversations')
        .insert({
          store_id: job.store_id,
          contact_id: contactId,
          status: 'open',
          unread_count: 0,
        })
        .select('id')
        .single()

      if (convError) {
        if ((convError as { code?: string }).code === '23505') {
          const { data: refetchedConv } = await supabase
            .from('wa_conversations')
            .select('id')
            .eq('contact_id', contactId)
            .neq('status', 'closed')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (!refetchedConv) throw new Error('Conversation insert conflict, refetch failed')
          conversationId = (refetchedConv as { id: string }).id
        } else {
          throw convError
        }
      } else {
        conversationId = (newConv as { id: string }).id
      }
    }

    // Send template via Meta WhatsApp API
    const WA_API_VERSION = process.env.WA_API_VERSION!
    const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID!
    const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN!
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
          to: job.phone_normalized,
          type: 'template',
          template: {
            name: 'order_confirmation_cod',
            language: { code: 'es' },
            components: [
              {
                type: 'header',
                parameters: [
                  {
                    type: 'image',
                    image: { link: WA_ORDER_CONFIRMATION_IMAGE_URL },
                  },
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
      throw new Error(`Meta API error ${metaRes.status}: ${metaErr}`)
    }

    const metaData = (await metaRes.json()) as { messages?: { id: string }[] }
    const wamid = metaData.messages?.[0]?.id
    if (!wamid) throw new Error('Meta returned OK but no wamid')

    const sentAt = new Date().toISOString()
    const templateBody = `👋 ¡Hola, ${customerName}!\n\nTu pedido de ${productSummary} ya está listo para envío.\n\n💰 RD$ ${codAmount}\n🚚 Entrega: 1–3 días laborables\n\n🎁 Tu oferta está reservada.\nPulsa Confirmar o No, gracias.`

    // Insert outbound wa_message
    await supabase.from('wa_messages').insert({
      store_id: job.store_id,
      conversation_id: conversationId,
      wa_msg_id: wamid,
      direction: 'outbound',
      message_type: 'template',
      body: templateBody,
      status: 'sent',
      sent_at: sentAt,
      metadata: {
        order_id: job.order_id,
        template_name: job.template_name,
        customer_name: customerName,
        product_summary: productSummary,
        cod_amount: codAmount,
        header_image_url: WA_ORDER_CONFIRMATION_IMAGE_URL,
        language: 'es',
        buttons: ['Confirmar', 'No, gracias'],
        sender_type: 'system',
      },
    })

    // Update conversation last message info
    await supabase
      .from('wa_conversations')
      .update({
        last_message_at: sentAt,
        last_message_preview: makePreview(templateBody),
      })
      .eq('id', conversationId)

    // Mark queue job as sent
    await supabase
      .from('wa_template_queue')
      .update({
        status: 'sent',
        wa_message_id: wamid,
        processed_at: sentAt,
      })
      .eq('id', job.id)

    return 'sent'
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[cron/wa-template-queue] job=${job.id} failed:`, errorMessage)

    await supabase
      .from('wa_template_queue')
      .update({
        status: 'failed',
        error_message: errorMessage,
        processed_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    return 'failed'
  }
}

// ── Template nuevo: sd_location_request (Sprint 3A) ──────────────────────
// Confirmación + solicitud de ubicación para pedidos de cobertura interna
// Santo Domingo (sin guía EFI). Supresión inteligente (spec sección 5):
// omite el envío si el pedido ya no aplica por cualquiera de estas razones,
// registrando siempre un skip_reason legible.
async function runSdLocationRequestJob(
  supabase: ServiceClient,
  job: Job,
  nowStr: string,
): Promise<'sent' | 'skipped' | 'failed'> {
  const skip = async (reason: string) => {
    await supabase
      .from('wa_template_queue')
      .update({ status: 'skipped', skip_reason: reason, processed_at: nowStr })
      .eq('id', job.id)
    return 'skipped' as const
  }

  try {
    // 1. Re-validar el pedido — puede haber cambiado desde que se encoló.
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, customer_name, product_summary, cod_amount, normalized_status, tracking_number, sd_location_received_at')
      .eq('id', job.order_id)
      .maybeSingle()

    if (orderError || !order) throw new Error(`Order not found: ${job.order_id}`)

    if (order.normalized_status === 'delivered') return skip('order_delivered')
    if (order.normalized_status === 'returned' || order.normalized_status === 'cancelled') return skip('order_cancelled')
    if (order.tracking_number) return skip('assigned_to_external_courier')
    if (order.sd_location_received_at) return skip('location_already_received')

    // 2. El mensajero ya inició ruta, o el cliente ya dijo que no quiere el
    //    pedido — ambas son resoluciones humanas más recientes que el motivo
    //    de este mensaje automático.
    const { data: recentActions } = await supabase
      .from('agent_actions')
      .select('action_type')
      .eq('order_id', job.order_id)
      .in('action_type', ['customer_declined', 'route_confirmed'])
      .limit(5)

    const actionTypes = new Set((recentActions ?? []).map(a => a.action_type as string))
    if (actionTypes.has('customer_declined')) return skip('customer_declined')
    if (actionTypes.has('route_confirmed')) return skip('already_en_route')

    // 3. Cliente ya escribió en la conversación después de crear el pedido
    //    (mismo criterio que order_confirmation_cod — evita interrumpir una
    //    conversación ya en curso).
    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('store_id', job.store_id)
      .eq('phone_normalized', job.phone_normalized)
      .maybeSingle()

    if (contact) {
      const { data: convs } = await supabase
        .from('wa_conversations')
        .select('id')
        .eq('contact_id', contact.id)

      if (convs && convs.length > 0) {
        const convIds = convs.map((c: { id: string }) => c.id)
        const { count } = await supabase
          .from('wa_messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .eq('direction', 'inbound')
          .gt('sent_at', job.created_at)

        if ((count ?? 0) > 0) return skip('client_already_wrote')
      }
    }

    // 4. Find-or-create contact + conversación abierta (mismo patrón que el
    //    template histórico — ver runOrderConfirmationJob).
    const customerName = (order.customer_name as string | null) ?? 'Cliente'
    let contactId: string
    if (contact) {
      contactId = contact.id
    } else {
      const { data: newContact, error: contactError } = await supabase
        .from('wa_contacts')
        .insert({ store_id: job.store_id, phone_normalized: job.phone_normalized, display_name: customerName, order_id: job.order_id })
        .select('id')
        .single()
      if (contactError) {
        if ((contactError as { code?: string }).code === '23505') {
          const { data: refetched } = await supabase
            .from('wa_contacts').select('id')
            .eq('store_id', job.store_id).eq('phone_normalized', job.phone_normalized)
            .maybeSingle()
          if (!refetched) throw new Error('Contact insert conflict, refetch failed')
          contactId = (refetched as { id: string }).id
        } else throw contactError
      } else {
        contactId = (newContact as { id: string }).id
      }
    }

    let conversationId: string
    const { data: existingConv } = await supabase
      .from('wa_conversations')
      .select('id')
      .eq('contact_id', contactId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingConv) {
      conversationId = (existingConv as { id: string }).id
    } else {
      const { data: newConv, error: convError } = await supabase
        .from('wa_conversations')
        .insert({ store_id: job.store_id, contact_id: contactId, status: 'open', unread_count: 0 })
        .select('id')
        .single()
      if (convError) {
        if ((convError as { code?: string }).code === '23505') {
          const { data: refetchedConv } = await supabase
            .from('wa_conversations').select('id')
            .eq('contact_id', contactId).neq('status', 'closed')
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (!refetchedConv) throw new Error('Conversation insert conflict, refetch failed')
          conversationId = (refetchedConv as { id: string }).id
        } else throw convError
      } else {
        conversationId = (newConv as { id: string }).id
      }
    }

    // 5. Enviar el template vía Meta. Confirmado contra la Graph API real
    //    (GET /{WA_WABA_ID}/message_templates) durante el Sprint Crítico 1:
    //    'sd_location_request' está APROBADO, category=UTILITY, idioma real
    //    'es_DO' (NO 'es' — Meta rechaza el envío si el language code no
    //    coincide exactamente con el aprobado). El template también tiene un
    //    HEADER tipo IMAGE obligatorio — sin su componente de header, Meta
    //    responde con error y el job queda 'failed'. WA_SD_LOCATION_IMAGE_URL
    //    permite una imagen propia para este mensaje; si no se define, reusa
    //    WA_ORDER_CONFIRMATION_IMAGE_URL (mismo asset que el template
    //    histórico) como fallback operativo, no decorativo.
    const WA_API_VERSION = process.env.WA_API_VERSION!
    const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID!
    const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN!
    const WA_SD_LOCATION_TEMPLATE_NAME = process.env.WA_SD_LOCATION_TEMPLATE_NAME ?? 'sd_location_request'
    const WA_SD_LOCATION_TEMPLATE_LANGUAGE = process.env.WA_SD_LOCATION_TEMPLATE_LANGUAGE ?? 'es_DO'
    const WA_SD_LOCATION_IMAGE_URL = process.env.WA_SD_LOCATION_IMAGE_URL || process.env.WA_ORDER_CONFIRMATION_IMAGE_URL!

    const productSummary = (order.product_summary as string | null) ?? 'tu pedido'
    const codAmount = String(order.cod_amount ?? '0')

    const metaRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: job.phone_normalized,
          type: 'template',
          template: {
            name: WA_SD_LOCATION_TEMPLATE_NAME,
            language: { code: WA_SD_LOCATION_TEMPLATE_LANGUAGE },
            components: [
              {
                type: 'header',
                parameters: [
                  { type: 'image', image: { link: WA_SD_LOCATION_IMAGE_URL } },
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
      throw new Error(`Meta API error ${metaRes.status}: ${metaErr}`)
    }

    const metaData = (await metaRes.json()) as { messages?: { id: string }[] }
    const wamid = metaData.messages?.[0]?.id
    if (!wamid) throw new Error('Meta returned OK but no wamid')

    const sentAt = new Date().toISOString()
    // Texto real del template aprobado en Meta (sd_location_request, es_DO) —
    // se guarda aquí solo como registro de auditoría en wa_messages.body;
    // Meta ya rellenó las variables {{1}}/{{2}}/{{3}} con los parámetros
    // enviados arriba, este string nunca se transmite.
    const templateBody =
      `Hola, *${customerName}* 👋\n\n` +
      `Soy el mensajero de LÜMA Teeth y ya tengo tu pedido de *${productSummary}* listo para entregártelo. 📦\n\n` +
      `Para organizar la ruta y llegar hasta donde estás, *por favor envíame tu ubicación* 📍.\n\n` +
      `Monto a pagar al recibir: *RD$ ${codAmount}*.\n\n` +
      `Quedo pendiente de tu ubicación para coordinar la entrega. ¡Gracias! 😊`

    await supabase.from('wa_messages').insert({
      store_id: job.store_id,
      conversation_id: conversationId,
      wa_msg_id: wamid,
      direction: 'outbound',
      message_type: 'template',
      body: templateBody,
      status: 'sent',
      sent_at: sentAt,
      metadata: {
        order_id: job.order_id,
        template_name: job.template_name,
        customer_name: customerName,
        product_summary: productSummary,
        cod_amount: codAmount,
        language: 'es',
        sender_type: 'system',
      },
    })

    await supabase
      .from('wa_conversations')
      .update({ last_message_at: sentAt, last_message_preview: makePreview(templateBody) })
      .eq('id', conversationId)

    await supabase
      .from('wa_template_queue')
      .update({ status: 'sent', wa_message_id: wamid, processed_at: sentAt })
      .eq('id', job.id)

    return 'sent'
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[cron/wa-template-queue] sd job=${job.id} failed:`, errorMessage)

    await supabase
      .from('wa_template_queue')
      .update({ status: 'failed', error_message: errorMessage, processed_at: new Date().toISOString() })
      .eq('id', job.id)

    return 'failed'
  }
}
