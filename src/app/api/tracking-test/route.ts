import { NextResponse } from 'next/server'
import { parseEFITracking } from '@/lib/tracking/efi-parser'

const EFI_BASE = 'https://effi.com.co/tracking/index'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const guia = searchParams.get('guia')?.trim()

  if (!guia) {
    return NextResponse.json({ error: 'Parámetro guia requerido' }, { status: 400 })
  }

  const url = `${EFI_BASE}/${encodeURIComponent(guia)}`

  let html: string
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9',
        'Cache-Control':   'no-cache',
      },
      // Sin cache — siempre datos frescos
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: `EFI respondió con HTTP ${res.status}`, url },
        { status: 502 },
      )
    }

    html = await res.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error de red'
    return NextResponse.json({ error: msg, url }, { status: 502 })
  }

  const result = parseEFITracking(html, guia)
  return NextResponse.json({ ...result, _url_consultada: url })
}
