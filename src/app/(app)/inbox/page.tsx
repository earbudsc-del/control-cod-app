'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import WaConversationList from '@/components/whatsapp/WaConversationList'
import WaMessagePane    from '@/components/whatsapp/WaMessagePane'
import type { WaConversation, WaMessage, WaAgentOption } from '@/components/whatsapp/types'
import { createClient } from '@/lib/supabase/client'

// Roles con acceso al Inbox WhatsApp — mismo set que is_wa_inbox_role() (migración 030 + 039).
const INBOX_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent', 'dispatch_agent', 'novelty_agent', 'agent', 'delivery_agent']

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

  const loadConversations = useCallback(async () => {
    setLoadingConvs(true)
    try {
      const res  = await fetch('/api/whatsapp/conversations?limit=100')
      const json = await res.json()
      if (res.ok && Array.isArray(json.data)) {
        setConversations(json.data)
      }
    } finally {
      setLoadingConvs(false)
    }
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

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

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/whatsapp/conversations?limit=100')
        if (!res.ok) return
        const json = await res.json()
        if (Array.isArray(json.data)) {
          setConversations(json.data)
        }
      } catch (err) {
        console.warn('[wa-conv-poll] error', err)
      }
    }

    const intervalId = setInterval(poll, 7000)
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
            last_message_preview: lastIncoming.body ?? c.last_message_preview,
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
              last_message_preview: msg.body ?? c.last_message_preview,
              last_message_at:      msg.sent_at ?? c.last_message_at,
              unread_count: isOpen
                ? 0
                : c.unread_count + (msg.direction === 'inbound' ? 1 : 0),
            }
          }))
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
          )

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
            setConversations(prev =>
              prev.some(c => c.id === convId) ? prev : [conv, ...prev]
            )
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
  }, [])

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
        />
      </div>

      <div className={`
        flex-1 min-w-0
        ${showPane ? 'flex' : 'hidden md:flex'}
      `}>
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
  )
}
