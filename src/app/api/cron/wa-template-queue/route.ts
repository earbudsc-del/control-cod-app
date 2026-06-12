import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

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

async function processJob(
  supabase: ServiceClient,
  job: Job,
): Promise<'sent' | 'skipped' | 'failed' | 'unclaimed'> {
  const nowStr = new Date().toISOString()

  // Atomic claim: only updates if still pending (prevents double-processing)
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
    const templatePreview = `[Template: ${job.template_name}] ${customerName} — ${productSummary}`

    // Insert outbound wa_message
    await supabase.from('wa_messages').insert({
      store_id: job.store_id,
      conversation_id: conversationId,
      wa_msg_id: wamid,
      direction: 'outbound',
      message_type: 'template',
      body: makePreview(templatePreview),
      status: 'sent',
      sent_at: sentAt,
    })

    // Update conversation last message info
    await supabase
      .from('wa_conversations')
      .update({
        last_message_at: sentAt,
        last_message_preview: makePreview(templatePreview),
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
