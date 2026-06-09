'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import WaConversationList from '@/components/whatsapp/WaConversationList'
import WaMessagePane    from '@/components/whatsapp/WaMessagePane'
import type { WaConversation, WaMessage } from '@/components/whatsapp/types'
import { createClient } from '@/lib/supabase/client'

export default function InboxPage() {
  const [conversations,    setConversations]    = useState<WaConversation[]>([])
  const [selectedId,       setSelectedId]       = useState<string | null>(null)
  const [selectedConv,     setSelectedConv]     = useState<WaConversation | null>(null)
  const [messages,         setMessages]         = useState<WaMessage[]>([])
  const [loadingConvs,     setLoadingConvs]     = useState(true)
  const [loadingMessages,  setLoadingMessages]  = useState(false)
  const [showPane,         setShowPane]         = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const selectedIdRef  = useRef<string | null>(null)

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

  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_messages' },
        (payload) => {
          const msg = payload.new as WaMessage & { conversation_id: string }
          if (msg.conversation_id === selectedIdRef.current) {
            setMessages(prev =>
              prev.some(m => m.id === msg.id) ? prev : [...prev, msg]
            )
          }
          setConversations(prev =>
            prev.map(c => {
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
            })
          )
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
          }
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
              }
            })
          )
        },
      )
      .subscribe((status) => console.log('[wa-realtime]', status))

    return () => { supabase.removeChannel(channel) }
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
      throw new Error('No se pudo enviar el mensaje. Inténtalo de nuevo.')
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
        />
      </div>
    </div>
  )
}
