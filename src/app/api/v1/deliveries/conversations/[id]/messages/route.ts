import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { getBearerToken, authenticateDeliveryRequest } from '@/lib/deliveries/auth'
import { checkConversationOrderAccess } from '@/lib/deliveries/conversations'
import type { SdOrderRow } from '@/lib/deliveries/sd-status'
import { buildSenderIdentity } from '@/lib/whatsapp/sender-identity'
import { sendWhatsAppText } from '@/lib/whatsapp/send-text'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

async function loadConversationForMessenger(
  supabase: ServiceClient,
  conversationId: string,
  storeId: string,
  userId: string,
  role: string,
) {
  const { data: conv } = await supabase
    .from('wa_conversations')
    .select('id, store_id, contact:wa_contacts(order_id, wa_id, phone_normalized)')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conv || conv.store_id !== storeId) return { kind: 'not_found' as const }

  type ContactRow = { order_id: string | null; wa_id: string | null; phone_normalized: string | null }
  const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as ContactRow | null
  if (!contact?.order_id) return { kind: 'not_found' as const }

  const { data: order } = await supabase
    .from('orders')
    .select('id, city, province, customer_address, tracking_number, normalized_status, confirmation_status, assigned_to')
    .eq('id', contact.order_id)
    .maybeSingle()

  if (!order) return { kind: 'not_found' as const }

  const access = checkConversationOrderAccess(order as SdOrderRow, userId, role)
  if (!access.allowed) return { kind: 'forbidden' as const }

  return { kind: 'ok' as const, contact, storeId: conv.store_id as string }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
    const { id } = await params
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const auth = await authenticateDeliveryRequest(token)
    if (auth.kind === 'unauthorized') return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    if (auth.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    const { userId, profile } = auth.user

    const supabase = await createServiceClient()
    const access = await loadConversationForMessenger(supabase, id, profile.store_id, userId, profile.role)
    if (access.kind === 'not_found') return NextResponse.json({ error: 'No encontrado' }, { status: 404, headers })
    if (access.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos sobre esta conversación' }, { status: 403, headers })

    const { searchParams } = new URL(request.url)
    const after = searchParams.get('after')

    if (after) {
      const { data, error } = await supabase
        .from('wa_messages')
        .select('id, direction, message_type, body, status, sent_at, delivered_at, read_at, wa_msg_id, metadata')
        .eq('conversation_id', id)
        .gt('sent_at', after)
        .order('sent_at', { ascending: true, nullsFirst: false })

      if (error) throw error
      return NextResponse.json({ messages: data ?? [], serverTime: new Date().toISOString() }, { status: 200, headers })
    }

    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'))
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT))))
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, error, count } = await supabase
      .from('wa_messages')
      .select('id, direction, message_type, body, status, sent_at, delivered_at, read_at, wa_msg_id, metadata', { count: 'exact' })
      .eq('conversation_id', id)
      .order('sent_at', { ascending: true, nullsFirst: false })
      .range(from, to)

    if (error) throw error

    return NextResponse.json({
      messages: data ?? [],
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
      serverTime: new Date().toISOString(),
    }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/conversations/[id]/messages]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
    const { id } = await params
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const auth = await authenticateDeliveryRequest(token)
    if (auth.kind === 'unauthorized') return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    if (auth.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    const { userId, profile } = auth.user

    const supabase = await createServiceClient()
    const access = await loadConversationForMessenger(supabase, id, profile.store_id, userId, profile.role)
    if (access.kind === 'not_found') return NextResponse.json({ error: 'No encontrado' }, { status: 404, headers })
    if (access.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos sobre esta conversación' }, { status: 403, headers })

    let body: { text?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Body inválido' }, { status: 400, headers })
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return NextResponse.json({ error: 'El campo text es requerido' }, { status: 422, headers })

    const waId = access.contact.wa_id ?? access.contact.phone_normalized
    if (!waId) return NextResponse.json({ error: 'El contacto no tiene wa_id ni teléfono' }, { status: 422, headers })

    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', userId)
      .maybeSingle()
    const identity = buildSenderIdentity(senderProfile)

    // Auto-introducción (una sola vez por conversación): si este es el
    // primer mensaje manual del mensajero en esta conversación, se envía
    // primero una presentación natural antes del mensaje real — nunca se
    // antepone el nombre en cada mensaje subsecuente.
    if (identity.sender_type === 'courier') {
      const { count: priorCourierMsgs } = await supabase
        .from('wa_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', id)
        .eq('metadata->>sender_type', 'courier')

      if (!priorCourierMsgs) {
        const introName = identity.sender_name ?? 'tu mensajero'
        const introText = `Hola, soy ${introName}, el mensajero encargado de tu entrega.`
        const introResult = await sendWhatsAppText(waId, introText)
        if (introResult.ok) {
          const introNow = new Date().toISOString()
          await supabase.from('wa_messages').insert({
            store_id: access.storeId,
            conversation_id: id,
            wa_msg_id: introResult.wamid,
            direction: 'outbound',
            message_type: 'text',
            body: introText,
            status: 'sent',
            sent_at: introNow,
            sent_by: userId,
            metadata: { sender_type: identity.sender_type, sender_name: identity.sender_name, sender_role: identity.sender_role, intro: true },
          })
        } else {
          console.error('[POST /api/v1/deliveries/conversations/[id]/messages] intro de mensajero falló', introResult.error)
        }
      }
    }

    const WA_API_VERSION = process.env.WA_API_VERSION!
    const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID!
    const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN!

    const metaRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: waId, type: 'text', text: { body: text } }),
      },
    )

    if (!metaRes.ok) {
      const metaErr = await metaRes.text()
      console.error('[POST /api/v1/deliveries/conversations/[id]/messages] Meta error', metaRes.status, metaErr)
      return NextResponse.json({ error: 'Error al enviar mensaje vía Meta' }, { status: 502, headers })
    }

    const metaData = (await metaRes.json()) as { messages?: { id: string }[] }
    const wamid = metaData.messages?.[0]?.id
    if (!wamid) {
      console.error('[POST /api/v1/deliveries/conversations/[id]/messages] Meta OK sin wamid', metaData)
      return NextResponse.json({ error: 'Meta respondió OK pero no devolvió el ID del mensaje' }, { status: 502, headers })
    }

    const now = new Date().toISOString()

    const { data: inserted, error: insertErr } = await supabase
      .from('wa_messages')
      .insert({
        store_id: access.storeId,
        conversation_id: id,
        wa_msg_id: wamid,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        sent_at: now,
        sent_by: userId,
        metadata: { sender_type: identity.sender_type, sender_name: identity.sender_name, sender_role: identity.sender_role },
      })
      .select()
      .single()

    if (insertErr) throw insertErr

    await supabase
      .from('wa_conversations')
      .update({ last_message_at: now, last_message_preview: text.slice(0, 100) })
      .eq('id', id)

    return NextResponse.json({ message: inserted }, { status: 201, headers })
  } catch (err) {
    console.error('[POST /api/v1/deliveries/conversations/[id]/messages]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
