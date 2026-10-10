import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'
import { processBroadcastQueue } from '@/lib/broadcast/processor'

// Sprint C.1 — processor de Broadcast. Endpoint PROPIO, separado del
// processor de automations (/api/cron/wa-template-queue), que sigue
// ignorando toda fila con broadcast_id.
//
// NO está registrado en vercel.json: programarlo es un paso explícito de
// despliegue (ver reporte C.1). Sin WA_BROADCAST_ENABLED='true' responde
// disabled antes de leer o escribir la cola.

export const maxDuration = 60

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isWaBroadcastEnabled()) {
    console.log('[WA_BROADCAST_DISABLED] step=cron/wa-broadcast-queue processed=0')
    return NextResponse.json({ disabled: true, processed: 0 })
  }

  try {
    const summary = await processBroadcastQueue({ db: await createServiceClient() })
    console.log('[broadcast-cron]', JSON.stringify(summary))
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[cron/wa-broadcast-queue]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
