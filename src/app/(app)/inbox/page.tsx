'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import WaConversationList, { type InboxFilterKey } from '@/components/whatsapp/WaConversationList'
import WaMessagePane    from '@/components/whatsapp/WaMessagePane'
import BroadcastContextPanel from '@/components/whatsapp/BroadcastContextPanel'
import LocationAssignmentPanel from '@/components/whatsapp/LocationAssignmentPanel'
import type { WaConversation, WaMessage, WaAgentOption } from '@/components/whatsapp/types'
import { createClient } from '@/lib/supabase/client'
import { messagePreview } from '@/lib/whatsapp/location-message'

// Roles con acceso al Inbox WhatsApp — mismo set que is_wa_inbox_role() (migración 030 + 039).
const INBOX_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent', 'dispatch_agent', 'novelty_agent', 'agent', 'delivery_agent']

const PAGE_LIMIT = 50
const RECONCILE_MS = 15_000     // re-sincroniza la primera página de la búsqueda/filtro activos
// Contadores tras eventos en tiempo real: como mucho una consulta cada 5 s
// aunque lleguen ráfagas (p. ej. una campaña enviándose).
const COUNTS_THROTTLE_MS = 5_000

// Orden canónico del servidor: last_message_at DESC NULLS LAST, id DESC.
function byActivity(a: WaConversation, b: WaConversation): number {
  const ta = a.last_message_at ? Date.parse(a.last_message_at) : null
  const tb = b.last_message_at ? Date.parse(b.last_message_at) : null
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return tb - ta
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

// ¿Sigue cumpliendo el filtro por columnas tras un cambio en tiempo real?
// (Sin atender / Campañas dependen de otras tablas: lo decide la re-sincronización.)
function stillMatches(c: WaConversation, filter: InboxFilterKey, userId: string | null): boolean {
  if (filter === 'unread') return c.unread_count > 0
  if (filter === 'unassigned') return !c.assigned_to
  if (filter === 'mine') return !!userId && c.assigned_to === userId
  return true
}

function listUrl(q: string, filter: InboxFilterKey, cursor?: string | null, withCounts = false): string {
  const p = new URLSearchParams({ filter, limit: String(PAGE_LIMIT) })
  if (withCounts) p.set('counts', '1')
  if (q.trim().length >= 2) p.set('q', q.trim())
  if (cursor) p.set('cursor', cursor)
  return `/api/whatsapp/conversations?${p}`
}

export default function InboxPage() {
  const searchParams = useSearchParams()
  const deepLinkHandled = useRef(false)
  const [conversations,    setConversations]    = useState<WaConversation[]>([])
  const [selectedId,       setSelectedId]       = useState<string | null>(null)
  const [selectedConv,     setSelectedConv]     = useState<WaConversation | null>(null)
  const [messages,         setMessages]         = useState<WaMessage[]>([])
  const [loadingConvs,     setLoadingConvs]     = useState(true)
  const [loadingMessages,  setLoadingMessages]  = useState(false)
  const [showPane,         setShowPane]         = useState(false)
  const [currentUserId,    setCurrentUserId]    = useState<string | null>(null)
  const [currentUserRole,  setCurrentUserRole]  = useState<string | null>(null)
  const [agents,           setAgents]           = useState<WaAgentOption[]>([])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const selectedIdRef  = useRef<string | null>(null)
  const messagesRef    = useRef<WaMessage[]>([])
  const agentsRef      = useRef<WaAgentOption[]>([])

  // Búsqueda global + filtro (servidor). `query` es lo que escribe el agente;
  // `searchQ` la versión con debounce que se envía.
  const [query,       setQuery]       = useState('')
  const [searchQ,     setSearchQ]     = useState('')
  const [filter,      setFilter]      = useState<InboxFilterKey>('all')
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [total,       setTotal]       = useState<number | null>(null)
  const [counts,      setCounts]      = useState<Partial<Record<InboxFilterKey, number>> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError,   setListError]   = useState<string | null>(null)
  const searchQRef  = useRef('')
  const filterRef   = useRef<InboxFilterKey>('all')
  const userIdRef   = useRef<string | null>(null)
  const requestSeq  = useRef(0)
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Scroll infinito: una sola petición de "siguiente página" a la vez y nunca
  // dos veces el mismo cursor.
  const loadingMoreRef   = useRef(false)
  const requestedCursors = useRef(new Set<string>())

  useEffect(() => {
    const t = setTimeout(() => setSearchQ(query), 300)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => { searchQRef.current = searchQ }, [searchQ])
  useEffect(() => { filterRef.current = filter }, [filter])

  const loadCounts = useCallback(async () => {
    try {
      const q = searchQRef.current.trim()
      const res = await fetch(`/api/whatsapp/conversations/counts${q.length >= 2 ? `?q=${encodeURIComponent(q)}` : ''}`)
      if (!res.ok) return
      const json = await res.json()
      if (json?.counts) setCounts(json.counts)
    } catch { /* los contadores son informativos */ }
  }, [])

  const scheduleCounts = useCallback(() => {
    if (countsTimer.current) return
    countsTimer.current = setTimeout(() => {
      countsTimer.current = null
      void loadCounts()
    }, COUNTS_THROTTLE_MS)
  }, [loadCounts])

  useEffect(() => () => { if (countsTimer.current) clearTimeout(countsTimer.current) }, [])

  // Primera página de la búsqueda/filtro activos (reemplaza la lista).
  const loadConversations = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoadingConvs(true)
    setListError(null)
    try {
      requestedCursors.current = new Set()
      const res  = await fetch(listUrl(searchQRef.current, filterRef.current, null, true))
      const json = await res.json().catch(() => null)
      if (seq !== requestSeq.current) return
      if (res.ok && Array.isArray(json?.data)) {
        setConversations(json.data)
        setNextCursor(json.next_cursor ?? null)
        setTotal(typeof json.total === 'number' ? json.total : null)
        if (json.counts) setCounts(json.counts)
      } else {
        setConversations([]); setNextCursor(null); setTotal(0)
        setListError(json?.error ?? 'No se pudieron cargar las conversaciones')
      }
    } finally {
      if (seq === requestSeq.current) setLoadingConvs(false)
    }
  }, [])

  // Lista + contadores en UNA petición (las consultas se comparten en el servidor).
  useEffect(() => {
    void loadConversations()
  }, [searchQ, filter, loadConversations])

  const loadMore = useCallback(async () => {
    const cursor = nextCursor
    if (!cursor || loadingMoreRef.current || requestedCursors.current.has(cursor)) return
    loadingMoreRef.current = true
    requestedCursors.current.add(cursor)
    const seq = requestSeq.current
    setLoadingMore(true)
    try {
      const res  = await fetch(listUrl(searchQRef.current, filterRef.current, cursor))
      const json = await res.json().catch(() => null)
      if (seq !== requestSeq.current) return
      if (!res.ok || !Array.isArray(json?.data)) {
        requestedCursors.current.delete(cursor)   // se puede reintentar con "Cargar más"
        return
      }
      setConversations(prev => {
        const seen = new Set(prev.map(c => c.id))
        return [...prev, ...(json.data as WaConversation[]).filter(c => !seen.has(c.id))]
      })
      setNextCursor(json.next_cursor ?? null)
      if (typeof json.total === 'number') setTotal(json.total)
    } finally {
      loadingMoreRef.current = false
      if (seq === requestSeq.current) setLoadingMore(false)
    }
  }, [nextCursor])
  const handleLoadMore = useCallback(() => { void loadMore() }, [loadMore])

  // Deep link ?conversation=<id> — usado por el botón "Abrir conversación (Inbox)"
  // del detalle operativo de un pedido (Reparto/Tránsito/orders/[id]). Abre esa
  // conversación aunque no esté en los primeros 100 resultados ya cargados.
  useEffect(() => {
    const convId = searchParams.get('conversation')
    if (!convId || deepLinkHandled.current) return
    deepLinkHandled.current = true
    fetch(`/api/whatsapp/conversations/${convId}`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (json?.data) selectConversation(json.data)
      })
      .catch(() => {})
  // selectConversation se define más abajo pero es function declaration (hoisted)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Re-sincronización periódica: la primera página de la MISMA búsqueda/filtro
  // se fusiona con lo cargado (no se pierden páginas ni la búsqueda) y trae
  // conversaciones que entraron al filtro y no estaban cargadas.
  useEffect(() => {
    const poll = async () => {
      const seq = requestSeq.current
      try {
        const res = await fetch(listUrl(searchQRef.current, filterRef.current, null, true))
        if (!res.ok) return
        const json = await res.json()
        if (seq !== requestSeq.current || !Array.isArray(json.data)) return
        if (json.counts) setCounts(json.counts)
        const fresh = json.data as WaConversation[]
        setConversations(prev => {
          const byId = new Map(prev.map(c => [c.id, c]))
          for (const c of fresh) byId.set(c.id, { ...byId.get(c.id), ...c })
          return [...byId.values()].sort(byActivity)
        })
        if (typeof json.total === 'number') setTotal(json.total)
      } catch (err) {
        console.warn('[wa-conv-poll] error', err)
      }
    }

    const intervalId = setInterval(poll, RECONCILE_MS)
    return () => clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { agentsRef.current = agents }, [agents])

  useEffect(() => {
    if (!selectedId) return
    const convId = selectedId

    const poll = async () => {
      if (selectedIdRef.current !== convId) return
      const current  = messagesRef.current
      const lastSent = current.length > 0 ? current[current.length - 1].sent_at : null
      const url = lastSent
        ? `/api/whatsapp/conversations/${convId}/messages?after=${encodeURIComponent(lastSent)}`
        : `/api/whatsapp/conversations/${convId}/messages?limit=50`

      try {
        const res = await fetch(url)
        if (!res.ok) return
        const json = await res.json()
        const incoming = Array.isArray(json.data) ? (json.data as WaMessage[]) : []
        if (selectedIdRef.current !== convId || incoming.length === 0) return

        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id))
          const newOnes = incoming.filter(m => !existingIds.has(m.id))
          return newOnes.length === 0 ? prev : [...prev, ...newOnes]
        })

        const lastIncoming = incoming[incoming.length - 1]
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            last_message_preview: messagePreview(lastIncoming),
            last_message_at:      lastIncoming.sent_at ?? c.last_message_at,
            unread_count:         0,
          }
        }))
      } catch (err) {
        console.warn('[wa-poll] error', { convId, err })
      }
    }

    const intervalId = setInterval(poll, 3000)
    return () => clearInterval(intervalId)
  }, [selectedId])

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id ?? null
      setCurrentUserId(uid)
      userIdRef.current = uid
      if (!uid) return
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', uid).maybeSingle()
      setCurrentUserRole(profile?.role ?? null)
    })
  }, [])

  // Agentes elegibles para el dropdown "Asignar a:" del header del Inbox.
  useEffect(() => {
    fetch('/api/profiles')
      .then(r => r.json())
      .then((json: unknown) => {
        const list = Array.isArray(json) ? json as Array<{ id: string; full_name: string; role: string }> : []
        setAgents(
          list
            .filter(p => INBOX_ROLES.includes(p.role))
            .map(p => ({ id: p.id, full_name: p.full_name, role: p.role })),
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    // Nombre único por ejecución del efecto — evita que RealtimeClient.channel()
    // reutilice un canal viejo todavía en "leaving" (no "closed") tras un cleanup
    // async sin terminar (StrictMode dev double-invoke / Fast Refresh / remount rápido).
    // Reutilizar el canal hace que .subscribe() sea un no-op silencioso en ese estado.
    const channelName = `inbox-realtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let cancelled = false
    const supabase = createClient()
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_messages' },
        (payload) => {
          if (cancelled) return
          const msg = payload.new as WaMessage & { conversation_id: string }
          const isForOpenConv = msg.conversation_id === selectedIdRef.current
          if (isForOpenConv) {
            setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg])
          }
          setConversations(prev => prev.map(c => {
            if (c.id !== msg.conversation_id) return c
            const isOpen = c.id === selectedIdRef.current
            return {
              ...c,
              // Sin texto (p. ej. ubicación) → "[tipo]", como el webhook; la lista lo muestra legible.
              last_message_preview: messagePreview(msg),
              last_message_at:      msg.sent_at ?? c.last_message_at,
              unread_count: isOpen
                ? 0
                : c.unread_count + (msg.direction === 'inbound' ? 1 : 0),
            }
          }).sort(byActivity))
          scheduleCounts()
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wa_conversations' },
        (payload) => {
          const updated = payload.new as {
            id: string
            status: WaConversation['status']
            last_message_preview: string | null
            last_message_at: string | null
            unread_count: number
            assigned_to: string | null
            ai_enabled: boolean
          }
          // El payload de realtime solo trae columnas crudas — el nombre del
          // agente asignado se resuelve localmente desde la lista ya cargada.
          const assignedAgent = updated.assigned_to
            ? agentsRef.current.find(a => a.id === updated.assigned_to) ?? null
            : null

          setConversations(prev =>
            prev.map(c => {
              if (c.id !== updated.id) return c
              const isOpen = c.id === selectedIdRef.current
              return {
                ...c,
                status:               updated.status,
                last_message_preview: updated.last_message_preview,
                last_message_at:      updated.last_message_at,
                unread_count:         isOpen ? 0 : updated.unread_count,
                assigned_to:          updated.assigned_to,
                ai_enabled:           updated.ai_enabled,
                assigned_agent:       assignedAgent,
              }
            })
              // La conversación abierta nunca desaparece de la lista mientras se trabaja.
              .filter(c => c.id === selectedIdRef.current || stillMatches(c, filterRef.current, userIdRef.current))
              .sort(byActivity)
          )
          scheduleCounts()

          // Mantiene el panel abierto sincronizado si otro agente toma/libera/
          // reasigna la conversación que el usuario actual tiene abierta.
          if (updated.id === selectedIdRef.current) {
            setSelectedConv(prev => prev ? {
              ...prev,
              status:         updated.status,
              assigned_to:    updated.assigned_to,
              ai_enabled:     updated.ai_enabled,
              assigned_agent: assignedAgent,
            } : prev)
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_conversations' },
        async (payload) => {
          const convId = (payload.new as { id: string }).id
          console.warn('[wa-realtime] INSERT wa_conversations', convId)
          try {
            const res = await fetch(`/api/whatsapp/conversations/${convId}`)
            if (!res.ok) {
              console.warn('[wa-realtime] fetch conversation !ok', res.status, convId)
              return
            }
            const json = await res.json()
            const conv: WaConversation = json.data
            if (!conv) {
              console.warn('[wa-realtime] conversation fetch empty', json, convId)
              return
            }
            // Conversación nueva: solo se inserta en la vista sin búsqueda ni
            // filtro; con búsqueda/filtro la trae la re-sincronización.
            if (searchQRef.current.trim().length < 2 && filterRef.current === 'all') {
              setConversations(prev =>
                prev.some(c => c.id === convId) ? prev : [conv, ...prev].sort(byActivity)
              )
            }
            scheduleCounts()
          } catch (err) {
            console.warn('[wa-realtime] fetch conversation threw', err, convId)
          }
        },
      )
      .subscribe((status, err) => {
        if (cancelled) return
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || err) {
          console.warn('[wa-realtime] subscribe error', { status, err: err?.message ?? null })
        }
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [scheduleCounts])

  async function selectConversation(conv: WaConversation) {
    selectedIdRef.current = conv.id
    setSelectedId(conv.id)
    setSelectedConv(conv)
    setShowPane(true)
    setLoadingMessages(true)
    setMessages([])

    try {
      const [convRes, msgsRes] = await Promise.all([
        fetch(`/api/whatsapp/conversations/${conv.id}`),
        fetch(`/api/whatsapp/conversations/${conv.id}/messages`),
      ])

      if (convRes.ok) {
        const data = await convRes.json()
        if (data.data) {
          setSelectedConv(data.data)
        }
      }

      if (msgsRes.ok) {
        const data = await msgsRes.json()
        if (Array.isArray(data.data)) {
          setMessages(data.data)
        }
      }
    } finally {
      setLoadingMessages(false)
    }

    if (conv.unread_count > 0) {
      fetch(`/api/whatsapp/conversations/${conv.id}/read`, { method: 'PATCH' })
        .then(r => {
          if (r.ok) {
            setConversations(prev =>
              prev.map(c => c.id === conv.id ? { ...c, unread_count: 0 } : c)
            )
          }
        })
        .catch(() => {})
    }
  }

  function handleBack() {
    setShowPane(false)
  }

  async function handleSend(text: string) {
    if (!selectedId) return
    const res = await fetch(`/api/whatsapp/conversations/${selectedId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (res.ok) {
      const { data } = await res.json()
      setMessages(prev => [...prev, data])
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedId
            ? { ...c, last_message_preview: text, last_message_at: data.sent_at, unread_count: 0 }
            : c
        )
      )
    } else {
      const body = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? 'No se pudo enviar el mensaje. Inténtalo de nuevo.')
    }
  }

  async function handleTakeConversation(conv: WaConversation) {
    const res = await fetch(`/api/whatsapp/conversations/${conv.id}/take`, {
      method: 'PATCH',
    })
    if (res.ok) {
      const { data } = await res.json()
      setSelectedConv(data)
      setConversations(prev =>
        prev.map(c => c.id === conv.id ? { ...c, ...data } : c)
      )
    }
  }

  async function handleReleaseConversation(conv: WaConversation) {
    const res = await fetch(`/api/whatsapp/conversations/${conv.id}/release`, {
      method: 'PATCH',
    })
    if (res.ok) {
      const { data } = await res.json()
      setSelectedConv(data)
      setConversations(prev =>
        prev.map(c => c.id === conv.id ? { ...c, ...data } : c)
      )
    }
  }

  async function handleAssignConversation(conv: WaConversation, assignedTo: string | null, aiEnabled: boolean) {
    const res = await fetch(`/api/whatsapp/conversations/${conv.id}/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: assignedTo, ai_enabled: aiEnabled }),
    })
    if (res.ok) {
      const { data } = await res.json()
      setSelectedConv(data)
      setConversations(prev =>
        prev.map(c => c.id === conv.id ? { ...c, ...data } : c)
      )
    }
  }

  return (
    <div className="-mx-4 -mb-4 md:-mx-6 md:-mb-6 h-[calc(100vh-56px)] md:h-screen flex overflow-hidden">
      <div className={`
        w-full md:w-80 lg:w-96 flex-shrink-0 border-r border-gray-200
        ${showPane ? 'hidden md:flex' : 'flex'} flex-col
      `}>
        <WaConversationList
          conversations={conversations}
          selectedId={selectedId}
          loading={loadingConvs}
          onSelect={selectConversation}
          query={query}
          onQueryChange={setQuery}
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          total={total}
          hasMore={!!nextCursor}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          error={listError}
          resetKey={`${searchQ}|${filter}`}
        />
      </div>

      <div className={`
        flex-1 min-w-0 flex-col
        ${showPane ? 'flex' : 'hidden md:flex'}
      `}>
        {/* Sprint C.1 — contexto de campaña Broadcast (se oculta si no aplica). */}
        {/* C.1.3 — ubicación ambigua pendiente de asociar (se oculta si no aplica). */}
        <LocationAssignmentPanel conversationId={selectedId} />
        <BroadcastContextPanel
          conversationId={selectedId}
          onChanged={() => {
            setConversations(prev => prev.map(c => c.id === selectedId ? { ...c, broadcast_attention: 0 } : c))
            scheduleCounts()
          }}
        />
        <div className="flex-1 min-h-0 flex">
        <WaMessagePane
          conversation={selectedConv}
          messages={messages}
          loading={loadingMessages}
          messagesEndRef={messagesEndRef}
          onBack={handleBack}
          onSend={handleSend}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          agents={agents}
          onTake={handleTakeConversation}
          onRelease={handleReleaseConversation}
          onAssign={handleAssignConversation}
        />
        </div>
      </div>
    </div>
  )
}
