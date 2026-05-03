import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { updateOrderTracking } from '@/lib/tracking/update-order'
import { createTaskIfNotExists, resolveAutoTasks } from '@/lib/tasks/auto-tasks'

const ACTIVE_STATUSES = ['in_transit', 'en_reparto', 'novedad', 'unknown']
const BATCH_SIZE      = 5
const BATCH_DELAY_MS  = 1_500

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const isCron = !!(cronSecret && req.headers.get('x-cron-secret') === cronSecret)

  // Elegir cliente según origen de la llamada:
  // - cron: service role → bypasea RLS
  // - usuario: cliente normal con sesión
  const supabase = isCron
    ? await createServiceClient()
    : await createClient()

  if (!isCron) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }
  }

  const { data: orders, error: fetchErr } = await supabase
    .from('orders')
    .select('id, tracking_number, normalized_status, last_tracking_update, store_id')
    .in('normalized_status', ACTIVE_STATUSES)
    .not('tracking_number', 'is', null)
    .order('last_tracking_update', { ascending: true, nullsFirst: true })
    .limit(200)

  // [DEBUG] — remover cuando ya no sea necesario
  console.log('[auto-tracking][debug] fetchErr:', fetchErr)
  console.log('[auto-tracking][debug] pedidos encontrados:', orders?.length ?? 0)
  if (orders && orders.length > 0) {
    orders.slice(0, 5).forEach(o => {
      console.log(`  guía=${o.tracking_number}  status=${o.normalized_status}  last_update=${o.last_tracking_update ?? 'null'}`)
    })
  }

  if (fetchErr) {
    return NextResponse.json({ error: 'Error al obtener pedidos' }, { status: 500 })
  }

  if (!orders || orders.length === 0) {
    return NextResponse.json({ processed: 0, updated: 0, failed: 0 })
  }

  let updated = 0
  let failed  = 0
  const errors: Array<{ orderId: string; error: string }> = []

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE)

    const results = await Promise.all(
      batch.map(o => updateOrderTracking(o.id, o.tracking_number, supabase))
    )

    const taskPromises: Promise<void>[] = []

    for (const [j, r] of results.entries()) {
      if (r.success) {
        updated++
        const order = batch[j]
        if (r.normalized_status !== undefined && order.store_id) {
          taskPromises.push(
            resolveAutoTasks(supabase, {
              orderId:          r.orderId,
              storeId:          order.store_id,
              normalizedStatus: r.normalized_status,
            }).catch(e => console.error('[auto-tasks]', r.orderId, e)),
          )
        }
      } else {
        failed++
        if (r.error) errors.push({ orderId: r.orderId, error: r.error })
      }
    }

    await Promise.all(taskPromises)

    if (i + BATCH_SIZE < orders.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  console.log(
    `[auto-tracking] processed=${orders.length} updated=${updated} failed=${failed}`,
  )

  // Confirmation tasks para pedidos sin confirmar (normalized_status = 'pending')
  const { data: pendingOrders } = await supabase
    .from('orders')
    .select('id, store_id')
    .eq('normalized_status', 'pending')
    .limit(100)

  if (pendingOrders?.length) {
    await Promise.all(
      pendingOrders.map(o =>
        createTaskIfNotExists(supabase, {
          orderId:  o.id,
          storeId:  o.store_id,
          taskType: 'confirmation',
          priority: 'high',
        }).catch(e => console.error('[auto-tasks][confirmation]', o.id, e)),
      ),
    )
    console.log(`[auto-tasks] confirmation tasks checked for ${pendingOrders.length} pending orders`)
  }

  return NextResponse.json({
    processed: orders.length,
    updated,
    failed,
    ...(errors.length > 0 && { errors: errors.slice(0, 20) }),
  })
}
