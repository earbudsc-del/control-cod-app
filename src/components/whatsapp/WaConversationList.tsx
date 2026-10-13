'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { MessageSquare, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WaConversation } from './types'
import { displayPreview } from '@/lib/whatsapp/location-message'

const RD_TZ = 'America/Santo_Domingo'

const AVATAR_COLORS = [
  'bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-600',
  'bg-teal-600', 'bg-cyan-600', 'bg-blue-600', 'bg-indigo-600',
  'bg-violet-600', 'bg-pink-600',
]

function avatarColor(key: string): string {
  return AVATAR_COLORS[(key.charCodeAt(0) || 0) % AVATAR_COLORS.length]
}

function initials(name: string | null, phone: string): string {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/)
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : name.trim().slice(0, 2).toUpperCase()
  }
  return phone.slice(-2)
}

function toRDDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RD_TZ }).format(d)
}

function formatConvTime(iso: string | null): string {
  if (!iso) return ''
  const d   = new Date(iso)
  const now = new Date()

  if (toRDDay(d) === toRDDay(now)) {
    return new Intl.DateTimeFormat('es-DO', {
      timeZone: RD_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d)
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (toRDDay(d) === toRDDay(yesterday)) return 'Ayer'

  return new Intl.DateTimeFormat('es-DO', {
    timeZone: RD_TZ, day: 'numeric', month: 'short',
  }).format(d)
}

function ConvSkeleton() {
  return (
    <div className="animate-pulse">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-gray-100">
          <div className="w-10 h-10 rounded-full bg-gray-200 flex-shrink-0" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3.5 bg-gray-200 rounded w-2/3" />
            <div className="h-3 bg-gray-200 rounded w-full" />
            <div className="h-2.5 bg-gray-100 rounded w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export type InboxFilterKey = 'all' | 'unread' | 'attention' | 'broadcast' | 'unassigned' | 'mine'

export const INBOX_FILTER_LABELS: Array<{ key: InboxFilterKey; label: string; title: string }> = [
  { key: 'all',        label: 'Todos',            title: 'Todas las conversaciones de la tienda' },
  { key: 'unread',     label: 'Sin leer',         title: 'Mensajes del cliente que nadie ha abierto' },
  { key: 'attention',  label: 'Sin atender',      title: 'Gestión pendiente (respuesta de campaña o escalamiento), aunque ya se haya leído' },
  { key: 'broadcast',  label: 'Campañas',         title: 'Recibieron una campaña de Broadcast' },
  { key: 'unassigned', label: 'Sin asignar',      title: 'Sin agente asignado' },
  { key: 'mine',       label: 'Asignados a mí',   title: 'Asignadas a ti' },
]

interface Props {
  conversations: WaConversation[]
  selectedId:    string | null
  loading:       boolean
  onSelect:      (conv: WaConversation) => void
  // Búsqueda global + filtros (servidor).
  query:         string
  onQueryChange: (q: string) => void
  filter:        InboxFilterKey
  onFilterChange: (f: InboxFilterKey) => void
  counts:        Partial<Record<InboxFilterKey, number>> | null
  total:         number | null
  hasMore:       boolean
  loadingMore:   boolean
  onLoadMore:    () => void
  error:         string | null
  // Cambia con la búsqueda/filtro activos: la lista vuelve arriba.
  resetKey:      string
}

// Distancia al final de la lista a la que se pide la siguiente página.
const LOAD_AHEAD_PX = 400

export default function WaConversationList({
  conversations, selectedId, loading, onSelect,
  query, onQueryChange, filter, onFilterChange, counts, total, hasMore, loadingMore, onLoadMore, error, resetKey,
}: Props) {
  const searching = query.trim().length >= 2
  const scrollRef   = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Ancla: hasta 5 filas visibles y su distancia al borde superior. Si la lista
  // cambia por encima (llega actividad nueva), se compensa el scroll con la
  // MEDIANA del desplazamiento — si una de las filas ancladas sube sola al tope
  // (recibió un mensaje), no arrastra la vista.
  const anchors = useRef<Array<{ id: string; top: number }>>([])

  const captureAnchor = () => {
    const el = scrollRef.current
    anchors.current = []
    if (!el || el.scrollTop <= 0) return
    const top = el.getBoundingClientRect().top
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-conv-id]'))) {
      const r = row.getBoundingClientRect()
      if (r.bottom <= top) continue
      anchors.current.push({ id: row.dataset.convId!, top: r.top - top })
      if (anchors.current.length >= 5) break
    }
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || anchors.current.length === 0) return
    const top = el.getBoundingClientRect().top
    const deltas = anchors.current.flatMap(a => {
      const row = el.querySelector<HTMLElement>(`[data-conv-id="${a.id}"]`)
      return row ? [(row.getBoundingClientRect().top - top) - a.top] : []
    }).sort((x, y) => x - y)
    if (deltas.length === 0) return
    const delta = deltas[Math.floor(deltas.length / 2)]
    if (Math.abs(delta) >= 1) el.scrollTop += delta
    captureAnchor()
  }, [conversations]) // eslint-disable-line react-hooks/exhaustive-deps

  // Nueva búsqueda o filtro → arriba.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    anchors.current = []
  }, [resetKey])

  // Scroll infinito: al acercarse al final se pide la siguiente página. Se
  // re-observa cuando cambia la lista, así una pantalla alta que aún no se
  // llena pide otra página (una por vez) en lugar de quedarse corta.
  useEffect(() => {
    const root = scrollRef.current, target = sentinelRef.current
    if (!root || !target || !hasMore || loading || loadingMore) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onLoadMore()
    }, { root, rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` })
    io.observe(target)
    return () => io.disconnect()
  }, [hasMore, loading, loadingMore, onLoadMore, conversations.length])
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 pt-3 pb-2 border-b border-gray-200 flex-shrink-0 bg-white space-y-2">
        <div className="flex items-center gap-2 px-1">
          <MessageSquare className="w-4 h-4 text-green-600" />
          <h1 className="font-semibold text-gray-900 text-sm">Inbox WhatsApp</h1>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="search" value={query} onChange={e => onQueryChange(e.target.value)}
            placeholder="Buscar nombre, teléfono o # pedido"
            aria-label="Buscar conversaciones"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-8 pr-8 text-sm focus:border-green-500 focus:bg-white focus:outline-none"
          />
          {query && (
            <button onClick={() => onQueryChange('')} aria-label="Limpiar búsqueda"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {INBOX_FILTER_LABELS.map(f => {
            const n = counts?.[f.key]
            const active = filter === f.key
            return (
              <button key={f.key} onClick={() => onFilterChange(f.key)} title={f.title}
                className={cn(
                  'flex-shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap',
                  active ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-green-400',
                )}>
                {f.label}{typeof n === 'number' ? ` · ${n}` : ''}
              </button>
            )
          })}
        </div>
        {!loading && total !== null && (
          <p className="px-1 text-[11px] text-gray-400">
            {searching ? 'Resultados: ' : ''}Mostrando {conversations.length} de {total} conversacion{total !== 1 ? 'es' : ''}
          </p>
        )}
      </div>

      <div ref={scrollRef} onScroll={captureAnchor} className="flex-1 overflow-y-auto bg-white [overflow-anchor:none]">
        {error && !loading && (
          <p className="m-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</p>
        )}
        {loading ? (
          <ConvSkeleton />
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400">
            <MessageSquare className="w-8 h-8 opacity-25" />
            <span className="text-sm">{searching ? 'Sin resultados para esta búsqueda' : 'Sin conversaciones'}</span>
          </div>
        ) : (
          conversations.map(conv => {
            const label     = conv.contact.display_name?.trim() || conv.contact.phone_normalized
            const initLabel = initials(conv.contact.display_name, conv.contact.phone_normalized)
            const color     = avatarColor(label)
            const selected  = conv.id === selectedId

            return (
              <button
                key={conv.id}
                data-conv-id={conv.id}
                onClick={() => onSelect(conv)}
                className={cn(
                  'w-full flex items-start gap-3 px-4 py-3 border-b border-gray-100',
                  'hover:bg-gray-50 transition-colors text-left',
                  selected && 'bg-indigo-50 hover:bg-indigo-50 border-l-2 border-l-indigo-500',
                )}
              >
                <div className={cn(
                  'w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center',
                  'text-white text-xs font-semibold', color,
                )}>
                  {initLabel}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className={cn(
                      'text-sm truncate',
                      conv.unread_count > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700',
                    )}>
                      {label}
                    </span>
                    <span className="text-[10px] text-gray-400 flex-shrink-0 whitespace-nowrap">
                      {formatConvTime(conv.last_message_at)}
                    </span>
                  </div>

                  <div className="flex items-end justify-between gap-1 mt-0.5">
                    <p className={cn(
                      'text-xs truncate flex-1',
                      conv.unread_count > 0 ? 'text-gray-700' : 'text-gray-400',
                    )}>
                      {displayPreview(conv.last_message_preview) ?? 'Sin mensajes'}
                    </p>
                    {conv.unread_count > 0 && (
                      <span className="flex-shrink-0 min-w-[18px] h-[18px] rounded-full bg-green-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
                        {conv.unread_count > 99 ? '99+' : conv.unread_count}
                      </span>
                    )}
                  </div>

                  <p className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1.5">
                    {conv.contact.phone_normalized}
                    {(conv.broadcast_attention ?? 0) > 0 && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-800">
                        Campaña · atender
                      </span>
                    )}
                    {conv.escalation_open && (
                      <span className="rounded-full bg-red-100 px-1.5 py-px text-[10px] font-semibold text-red-700">
                        Escalado · atender
                      </span>
                    )}
                  </p>
                </div>
              </button>
            )
          })
        )}
        {!loading && hasMore && (
          <div ref={sentinelRef} className="p-3">
            <button onClick={onLoadMore} disabled={loadingMore}
              className="w-full rounded-lg border border-gray-200 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              {loadingMore ? 'Cargando…' : 'Cargar más'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
