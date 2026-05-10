'use client'

import { useEffect, useState, use, useRef, useCallback } from 'react'
import { useRouter }    from 'next/navigation'
import Link             from 'next/link'
import { Spinner }      from '@/components/ui/spinner'
import { formatDate }   from '@/lib/utils'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'
import type { AbandonedCart, CartRecoveryStatus } from '@/types'
import {
  ArrowLeft, MessageCircle, Phone, CheckCircle2, XCircle, Clock,
  AlertTriangle, RotateCcw, StickyNote, ExternalLink, Package,
  Mail, User, ShoppingBag, X, RefreshCw, AlertCircle,
  Zap, MapPinOff, Building2, HelpCircle, Navigation, Copy, Check,
} from 'lucide-react'

// ── Tipos locales ─────────────────────────────────────────────────────────────

interface RecoveredOrder {
  id:            string
  tracking_number: string
  order_number:  string | null
}

interface CartDetail {
  cart:           AbandonedCart
  recoveredOrder: RecoveredOrder | null
}

// ── Constantes ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<CartRecoveryStatus, string> = {
  pending:   'Pendiente',
  contacted: 'Contactado',
  no_answer: 'No responde',
  recovered: 'Recuperado',
  discarded: 'Descartado',
}

const STATUS_STYLES: Record<CartRecoveryStatus, string> = {
  pending:   'bg-gray-100 text-gray-700',
  contacted: 'bg-indigo-100 text-indigo-700',
  no_answer: 'bg-yellow-100 text-yellow-700',
  recovered: 'bg-green-100 text-green-700',
  discarded: 'bg-gray-200 text-gray-500',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits
  if (digits.length === 10) return `1${digits}`
  return digits.length >= 7 ? digits : null
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms   = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  const hrs  = Math.floor(ms / 3600000)
  const days = Math.floor(ms / 86400000)
  if (mins < 1)   return 'Ahora'
  if (mins < 60)  return `Hace ${mins}m`
  if (hrs  < 24)  return `Hace ${hrs}h`
  if (days === 1) return 'Ayer'
  return `Hace ${days} días`
}

function buildWAMessage(cart: AbandonedCart): string {
  const nombre   = cart.customer_name?.split(' ')[0] ?? 'cliente'
  const producto = cart.products_summary ?? 'tu pedido'
  const coverage = checkCoverage(cart.customer_address, cart.city)
  const isSD     = isSantoDomingoOrder(cart.city, cart.province, cart.customer_address)

  let intro: string
  if (cart.source === 'shopify_draft_order') {
    intro = `Tu pedido de ${producto} quedó casi listo en nuestra tienda.`
  } else if (cart.source === 'cod_form_lead') {
    intro = `Vimos que comenzaste un pedido de ${producto} en nuestra tienda.`
  } else {
    intro = `Dejaste tu pedido de ${producto} casi listo.`
  }

  let closing: string
  if (coverage.isOutOfCoverage) {
    closing = `Antes de procesarlo, queremos validar si tenemos cobertura para tu zona (${cart.city ?? 'tu ciudad'}).`
  } else if (isSD) {
    closing = `Como estás en Santo Domingo, podemos coordinar entrega rápida con nuestro transporte local.`
  } else {
    closing = `Hacemos entrega con pago contra entrega, sin necesidad de pagar por adelantado.`
  }

  return `Hola ${nombre} 😊 ${intro} ¿Quieres que te ayudemos a completarlo? ${closing}`
}

// ── Timeline builder ──────────────────────────────────────────────────────────

interface TimelineEvent {
  id:     string
  label:  string
  sub?:   string
  time:   string | null
  dot:    string
}

function buildTimeline(cart: AbandonedCart): TimelineEvent[] {
  const events: TimelineEvent[] = []

  events.push({
    id: 'created', time: cart.created_at,
    label: 'Carrito registrado',
    dot: 'bg-gray-400',
  })

  if (cart.abandoned_at && cart.abandoned_at !== cart.created_at) {
    const label =
      cart.source === 'shopify_draft_order'        ? 'Sincronizado desde Shopify Drafts'      :
      cart.source === 'cod_form_lead'              ? 'Lead recibido vía COD Form'              :
      cart.source === 'shopify_abandoned_checkout' ? 'Sincronizado desde Shopify Checkouts'   :
      'Abandono registrado'
    events.push({
      id: 'abandoned', time: cart.abandoned_at, label,
      sub: cart.shopify_draft_order_name ?? undefined,
      dot: 'bg-violet-400',
    })
  }

  if (cart.last_contacted_at) {
    events.push({
      id: 'contacted', time: cart.last_contacted_at,
      label: `Contactado — ${cart.recovery_attempts} intento${cart.recovery_attempts !== 1 ? 's' : ''}`,
      dot: 'bg-indigo-400',
    })
  }

  if (cart.completed_at) {
    events.push({
      id: 'completed', time: cart.completed_at,
      label: 'Completado en Shopify (pedido real generado)',
      dot: 'bg-green-500',
    })
  }

  if (cart.recovery_status === 'recovered' && !cart.completed_at) {
    events.push({
      id: 'recovered', time: cart.updated_at,
      label: 'Marcado como recuperado',
      dot: 'bg-green-500',
    })
  }

  if (cart.recovery_status === 'discarded') {
    events.push({
      id: 'discarded', time: cart.updated_at,
      label: 'Descartado por el agente',
      dot: 'bg-gray-300',
    })
  }

  events.sort((a, b) => {
    if (!a.time) return 1
    if (!b.time) return -1
    return new Date(b.time).getTime() - new Date(a.time).getTime()
  })

  return events
}

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null
  if (source === 'shopify_draft_order') return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-700 border border-violet-200">
      Shopify Draft
    </span>
  )
  if (source === 'shopify_abandoned_checkout' || source === 'shopify') return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
      Shopify Checkout
    </span>
  )
  if (source === 'cod_form_lead') return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 border border-blue-200">
      COD Form
    </span>
  )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-500 border border-gray-200">
      {source}
    </span>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function CartDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id }  = use(params)
  const router  = useRouter()

  const [detail,    setDetail]    = useState<CartDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading,   setLoading]   = useState(true)

  // Note modal
  const [noteText,   setNoteText]   = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [noteOpen,   setNoteOpen]   = useState(false)

  // WA copy
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Toast
  const [toast,    setToast]    = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, type })
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }

  // ── Carga ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res  = await fetch(`/api/abandoned-carts/${id}`)
      const json = await res.json()
      if (!res.ok) {
        setLoadError(json.error ?? 'Error al cargar')
        return
      }
      setDetail(json as CartDetail)
    } catch {
      setLoadError('Error de conexión. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // ── Acciones ────────────────────────────────────────────────────────────────

  async function handleStatus(status: CartRecoveryStatus) {
    try {
      const res  = await fetch(`/api/abandoned-carts/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      showToast(`Marcado como "${STATUS_LABELS[status]}"`)
      setDetail(prev => prev ? { ...prev, cart: json.cart } : prev)
    } catch (e) {
      showToast(String(e), 'error')
    }
  }

  async function handleSaveNote() {
    if (!noteText.trim()) return
    setSavingNote(true)
    try {
      const res  = await fetch(`/api/abandoned-carts/${id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteText.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setDetail(prev => prev ? { ...prev, cart: { ...prev.cart, notes: json.notes } } : prev)
      showToast('Nota guardada')
      setNoteText('')
      setNoteOpen(false)
    } catch (e) {
      showToast(String(e), 'error')
    } finally {
      setSavingNote(false)
    }
  }

  function handleCopyWA(msg: string) {
    navigator.clipboard.writeText(msg).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Estados de carga ────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8 text-indigo-600" />
    </div>
  )

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 px-4 text-center">
      <AlertCircle className="w-10 h-10 text-red-400" />
      <div>
        <p className="text-gray-700 font-medium">No se pudo cargar el carrito</p>
        <p className="text-gray-500 text-sm mt-1">{loadError}</p>
      </div>
      <div className="flex gap-3">
        <button onClick={load}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
          <RefreshCw className="w-4 h-4" /> Reintentar
        </button>
        <button onClick={() => router.back()}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Volver
        </button>
      </div>
    </div>
  )

  if (!detail?.cart) return (
    <div className="px-4 py-8 text-center">
      <p className="text-gray-500">Carrito no encontrado.</p>
      <button onClick={() => router.back()} className="text-indigo-600 text-sm mt-2 hover:underline">Volver</button>
    </div>
  )

  const { cart, recoveredOrder } = detail
  const coverage = checkCoverage(cart.customer_address, cart.city)
  const isSD     = isSantoDomingoOrder(cart.city, cart.province, cart.customer_address)
  const waPhone  = formatPhone(cart.customer_phone)
  const waMsg    = buildWAMessage(cart)
  const timeline = buildTimeline(cart)

  // Notas: split por \n\n para historial
  const noteEntries = cart.notes ? cart.notes.split('\n\n').filter(Boolean) : []

  // Información de marketing presente
  const hasMarketing = !!(cart.utm_source || cart.utm_campaign || cart.utm_content || cart.referrer || cart.page_url)

  return (
    <div className="space-y-4 md:space-y-5 max-w-5xl">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white max-w-sm
                        ${toast.type === 'error' ? 'bg-red-600' : 'bg-gray-900'}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => router.push('/carritos-abandonados')}
          className="mt-1 p-1 -ml-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg md:text-xl font-bold text-gray-900 truncate">
              {cart.customer_name ?? 'Sin nombre'}
            </h1>
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[cart.recovery_status]}`}>
              {STATUS_LABELS[cart.recovery_status]}
            </span>
            <SourceBadge source={cart.source} />
            {cart.shopify_draft_order_name && (
              <span className="font-mono text-sm text-violet-600 font-bold">
                {cart.shopify_draft_order_name}
              </span>
            )}
          </div>
          {cart.customer_phone && (
            <p className="text-sm text-gray-500 mt-0.5">{cart.customer_phone}</p>
          )}
        </div>
      </div>

      {/* Banners de cobertura */}
      {coverage.isOutOfCoverage && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
          <MapPinOff className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-800 text-sm">Zona fuera de cobertura</p>
            <p className="text-sm text-red-700 mt-0.5">
              Verificar antes de confirmar.
              {coverage.matchedZones.length > 0 && <> Zona: <strong>{coverage.matchedZones.join(', ')}</strong>.</>}
            </p>
          </div>
        </div>
      )}
      {!coverage.isOutOfCoverage && coverage.isSpecialDestination && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-start gap-3">
          <Navigation className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-blue-800 text-sm">Destino especial — coordinación requerida</p>
            {coverage.matchedZones.length > 0 && (
              <p className="text-sm text-blue-700 mt-0.5">Zona: <strong>{coverage.matchedZones.join(', ')}</strong></p>
            )}
          </div>
        </div>
      )}
      {!coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone && cart.city && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 flex items-start gap-3">
          <HelpCircle className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-yellow-800 text-sm">Zona no verificada — confirmar ubicación</p>
            <p className="text-sm text-yellow-700 mt-0.5">Ciudad &quot;{cart.city}&quot; no está en la matriz de cobertura.</p>
          </div>
        </div>
      )}
      {isSD && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 flex items-start gap-3">
          <Building2 className="w-5 h-5 text-purple-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-purple-800 text-sm">Santo Domingo — Transporte local disponible</p>
            <p className="text-sm text-purple-700 mt-0.5">Entrega con motoboys o transporte propio.</p>
          </div>
        </div>
      )}

      {/* Banner recuperado */}
      {cart.recovery_status === 'recovered' && recoveredOrder && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-green-800 text-sm">Carrito recuperado</p>
            <p className="text-sm text-green-700 mt-0.5">
              Pedido creado:{' '}
              <Link href={`/orders/${recoveredOrder.id}`}
                className="font-bold underline hover:text-green-900 font-mono">
                {recoveredOrder.tracking_number}
                {recoveredOrder.order_number && ` (${recoveredOrder.order_number})`}
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Grid principal */}
      <div className="grid lg:grid-cols-3 gap-4 md:gap-5">

        {/* ── Columna izquierda ── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Cliente */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
              <User className="w-4 h-4 text-gray-400" /> Datos del cliente
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Nombre</dt>
                <dd className="font-medium text-gray-800">{cart.customer_name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Teléfono</dt>
                <dd className="font-medium text-gray-800 break-all">
                  {cart.customer_phone
                    ? <a href={`tel:${cart.customer_phone}`} className="hover:text-indigo-600 underline decoration-dotted">{cart.customer_phone}</a>
                    : '—'
                  }
                </dd>
              </div>
              {cart.customer_email && (
                <div className="col-span-2">
                  <dt className="text-gray-400 text-xs mb-0.5 flex items-center gap-1">
                    <Mail className="w-3 h-3" /> Email
                  </dt>
                  <dd className="text-gray-700 break-all">{cart.customer_email}</dd>
                </div>
              )}
              {cart.customer_address && (
                <div className="col-span-2">
                  <dt className="text-gray-400 text-xs mb-0.5">Dirección</dt>
                  <dd className="text-gray-700">{cart.customer_address}</dd>
                </div>
              )}
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Ciudad</dt>
                <dd className="text-gray-700">{cart.city ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Provincia</dt>
                <dd className="text-gray-700">{cart.province ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Abandonado</dt>
                <dd className="text-gray-700">{cart.abandoned_at ? formatDate(cart.abandoned_at, true) : '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Último contacto</dt>
                <dd className="text-gray-700">
                  {cart.last_contacted_at ? timeAgo(cart.last_contacted_at) : '—'}
                </dd>
              </div>
            </dl>
          </div>

          {/* Producto / Pedido */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-gray-400" /> Producto / Pedido
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="col-span-2">
                <dt className="text-gray-400 text-xs mb-0.5">Productos</dt>
                <dd className="text-gray-800">{cart.products_summary ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Monto</dt>
                <dd className="font-bold text-gray-900 text-base tabular-nums">
                  {cart.total_amount != null
                    ? `RD$ ${cart.total_amount.toLocaleString('es-DO', { minimumFractionDigits: 2 })}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Moneda</dt>
                <dd className="text-gray-700">{cart.currency ?? 'DOP'}</dd>
              </div>
              {cart.shopify_draft_order_name && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Draft Order</dt>
                  <dd className="font-mono font-bold text-violet-700">{cart.shopify_draft_order_name}</dd>
                </div>
              )}
              {cart.draft_status && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Estado draft</dt>
                  <dd className="text-gray-700 capitalize">{cart.draft_status}</dd>
                </div>
              )}
              {cart.product_id && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Product ID</dt>
                  <dd className="font-mono text-xs text-gray-500">{cart.product_id}</dd>
                </div>
              )}
              {cart.variant_id && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Variant ID</dt>
                  <dd className="font-mono text-xs text-gray-500">{cart.variant_id}</dd>
                </div>
              )}
              {cart.checkout_url && (
                <div className="col-span-2">
                  <dt className="text-gray-400 text-xs mb-0.5">
                    {cart.source === 'shopify_draft_order' ? 'Invoice URL' : 'Checkout URL'}
                  </dt>
                  <dd>
                    <a href={cart.checkout_url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 text-xs underline decoration-dotted">
                      <ExternalLink className="w-3 h-3" />
                      {cart.source === 'shopify_draft_order' ? 'Abrir invoice en Shopify' : 'Abrir checkout'}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Tracking marketing — solo si hay datos */}
          {hasMarketing && (
            <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
                <Package className="w-4 h-4 text-gray-400" /> Tracking marketing
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {cart.utm_source && (
                  <div>
                    <dt className="text-gray-400 text-xs mb-0.5">UTM Source</dt>
                    <dd className="text-gray-700 font-mono text-xs">{cart.utm_source}</dd>
                  </div>
                )}
                {cart.utm_campaign && (
                  <div>
                    <dt className="text-gray-400 text-xs mb-0.5">UTM Campaign</dt>
                    <dd className="text-gray-700 font-mono text-xs">{cart.utm_campaign}</dd>
                  </div>
                )}
                {cart.utm_content && (
                  <div>
                    <dt className="text-gray-400 text-xs mb-0.5">UTM Content</dt>
                    <dd className="text-gray-700 font-mono text-xs">{cart.utm_content}</dd>
                  </div>
                )}
                {cart.referrer && (
                  <div className="col-span-2">
                    <dt className="text-gray-400 text-xs mb-0.5">Referrer</dt>
                    <dd className="text-gray-700 text-xs break-all">{cart.referrer}</dd>
                  </div>
                )}
                {cart.page_url && (
                  <div className="col-span-2">
                    <dt className="text-gray-400 text-xs mb-0.5">Página de origen</dt>
                    <dd className="text-xs break-all">
                      <a href={cart.page_url} target="_blank" rel="noreferrer"
                        className="text-indigo-600 hover:underline">{cart.page_url}</a>
                    </dd>
                  </div>
                )}
                {cart.session_id && (
                  <div className="col-span-2">
                    <dt className="text-gray-400 text-xs mb-0.5">Session ID</dt>
                    <dd className="font-mono text-[10px] text-gray-400">{cart.session_id}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Señales IA — estructura preparada */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
                <Zap className="w-4 h-4 text-violet-400" />
                Señales de intención
              </h2>
              <span className="text-[10px] bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full font-semibold border border-violet-200">
                IA próxima
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Score intención',      desc: 'Alta / Media / Baja' },
                { label: 'Prob. recuperación',   desc: '0–100%' },
                { label: 'Riesgo fake lead',     desc: 'Bajo / Medio / Alto' },
                { label: 'Cliente frecuente',    desc: 'Sí / No / Desconocido' },
              ].map(({ label, desc }) => (
                <div key={label} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-[10px] text-gray-400 font-medium leading-tight">{label}</p>
                  <p className="text-xl font-black text-gray-200 tabular-nums mt-1">—</p>
                  <p className="text-[9px] text-gray-300 mt-0.5">{desc}</p>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-3">
              Esta sección se habilitará cuando el supervisor IA esté activo. Los scores se calcularán automáticamente a partir del historial de comportamiento del cliente y patrones de abandono.
            </p>
          </div>

          {/* Timeline */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" />
              Historial operativo
            </h2>

            {/* Eventos clave */}
            <div className="space-y-3 mb-4">
              {timeline.map(event => (
                <div key={event.id} className="flex gap-3 text-sm">
                  <div className={`w-2 h-2 rounded-full ${event.dot} mt-1.5 shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-800 font-medium text-xs">{event.label}</p>
                    {event.sub && (
                      <p className="text-[10px] font-mono text-violet-600 mt-0.5">{event.sub}</p>
                    )}
                    {event.time && (
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {formatDate(event.time, true)} · {timeAgo(event.time)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Historial de notas */}
            {noteEntries.length > 0 && (
              <div className="border-t border-gray-50 pt-4 space-y-2">
                <p className="text-xs font-semibold text-gray-500 mb-2">
                  Notas registradas ({noteEntries.length})
                </p>
                {noteEntries.map((entry, i) => (
                  <div key={i} className="bg-amber-50 rounded-lg px-3 py-2 border border-amber-100">
                    <p className="text-xs text-gray-700 whitespace-pre-line">{entry}</p>
                  </div>
                ))}
              </div>
            )}

            {noteEntries.length === 0 && (
              <p className="text-xs text-gray-400 italic">Sin notas registradas aún.</p>
            )}
          </div>
        </div>

        {/* ── Columna derecha ── */}
        <div className="space-y-4">

          {/* Estado actual */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Estado del carrito</h3>
            <div className="space-y-1.5">
              {([
                { s: 'pending',   label: 'Pendiente',  icon: Clock },
                { s: 'contacted', label: 'Contactado', icon: Phone },
                { s: 'no_answer', label: 'No responde', icon: AlertTriangle },
                { s: 'recovered', label: 'Recuperado', icon: CheckCircle2 },
                { s: 'discarded', label: 'Descartado', icon: XCircle },
              ] as { s: CartRecoveryStatus; label: string; icon: React.ElementType }[]).map(({ s, label, icon: Icon }) => (
                <button
                  key={s}
                  onClick={() => handleStatus(s)}
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-left border transition-colors
                    ${cart.recovery_status === s
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-100 hover:bg-gray-50'
                    }`}
                >
                  <Icon className={`w-4 h-4 ${cart.recovery_status === s ? 'text-indigo-600' : 'text-gray-400'}`} />
                  <span className={cart.recovery_status === s ? 'font-semibold text-indigo-700' : 'text-gray-700'}>
                    {label}
                  </span>
                  {cart.recovery_status === s && (
                    <Check className="w-3 h-3 text-indigo-500 ml-auto" />
                  )}
                </button>
              ))}
            </div>
            {cart.recovery_attempts > 0 && (
              <p className="text-xs text-gray-400 mt-2">
                {cart.recovery_attempts} intento{cart.recovery_attempts !== 1 ? 's' : ''} registrado{cart.recovery_attempts !== 1 ? 's' : ''}
              </p>
            )}
            {recoveredOrder && (
              <Link href={`/orders/${recoveredOrder.id}`}
                className="mt-3 flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-green-700 bg-green-50 border border-green-200 hover:bg-green-100 transition-colors">
                <ExternalLink className="w-4 h-4" />
                Ver orden recuperada
                <span className="font-mono text-xs ml-auto">{recoveredOrder.tracking_number}</span>
              </Link>
            )}
          </div>

          {/* Acciones de contacto */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Contactar</h3>
            <div className="space-y-2">
              {waPhone ? (
                <a href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waMsg)}`}
                  target="_blank" rel="noreferrer"
                  onClick={() => handleStatus('contacted')}
                  className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors">
                  <MessageCircle className="w-4 h-4" />
                  WhatsApp
                </a>
              ) : (
                <p className="text-xs text-gray-400 italic">Sin número de teléfono registrado</p>
              )}
              {cart.customer_phone && (
                <a href={`tel:${cart.customer_phone}`}
                  onClick={() => handleStatus('contacted')}
                  className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 transition-colors border border-blue-200">
                  <Phone className="w-4 h-4" />
                  Llamar
                </a>
              )}
              <button
                onClick={() => setNoteOpen(true)}
                className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors border border-amber-200">
                <StickyNote className="w-4 h-4" />
                Agregar nota
              </button>
              {cart.recovery_status === 'discarded' && (
                <button onClick={() => handleStatus('pending')}
                  className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors">
                  <RotateCcw className="w-4 h-4" />
                  Reabrir carrito
                </button>
              )}
            </div>
          </div>

          {/* Mensaje WA sugerido */}
          {waPhone && (
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-900 text-sm">Mensaje sugerido</h3>
                <button
                  onClick={() => handleCopyWA(waMsg)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 border border-gray-100 leading-relaxed whitespace-pre-wrap">
                {waMsg}
              </p>
              <p className="text-[10px] text-gray-400 mt-2 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
                El botón WhatsApp usa este mensaje y marca el carrito como contactado automáticamente.
              </p>
            </div>
          )}

          {/* Cobertura resumen */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Cobertura</h3>
            <div className="space-y-1.5 text-sm">
              {isSD && (
                <div className="flex items-center gap-2 text-purple-700">
                  <Building2 className="w-4 h-4 shrink-0" />
                  Santo Domingo — transporte local
                </div>
              )}
              {coverage.isOutOfCoverage && (
                <div className="flex items-center gap-2 text-red-600">
                  <MapPinOff className="w-4 h-4 shrink-0" />
                  Fuera de cobertura
                </div>
              )}
              {!coverage.isOutOfCoverage && coverage.isSpecialDestination && (
                <div className="flex items-center gap-2 text-blue-600">
                  <Navigation className="w-4 h-4 shrink-0" />
                  Destino especial
                </div>
              )}
              {!coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone && (
                <div className="flex items-center gap-2 text-yellow-600">
                  <HelpCircle className="w-4 h-4 shrink-0" />
                  Zona desconocida
                </div>
              )}
              {!isSD && !coverage.isOutOfCoverage && !coverage.isSpecialDestination && !coverage.isUnknownZone && (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Dentro de cobertura
                </div>
              )}
              {cart.city && (
                <p className="text-xs text-gray-400 mt-1">{[cart.city, cart.province].filter(Boolean).join(', ')}</p>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Modal nota */}
      {noteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900 text-lg">Agregar nota</h2>
              <button onClick={() => { setNoteOpen(false); setNoteText('') }} className="text-gray-400 hover:text-gray-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-500">
              Carrito de <span className="font-medium text-gray-700">{cart.customer_name ?? 'cliente'}</span>
            </p>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Escribe una nota sobre este carrito…"
              rows={4}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setNoteOpen(false); setNoteText('') }}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveNote}
                disabled={!noteText.trim() || savingNote}
                className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {savingNote ? 'Guardando…' : 'Guardar nota'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
