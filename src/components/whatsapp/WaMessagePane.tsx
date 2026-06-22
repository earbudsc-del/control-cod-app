'use client'

import React, { useState, useRef, useCallback } from 'react'
import type { RefObject } from 'react'
import { ArrowLeft, MessageSquare, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WaConversation, WaMessage, WaTemplateMetadata, WaAgentOption } from './types'

const RD_TZ = 'America/Santo_Domingo'

const STATUS_LABEL: Record<string, string> = {
  open:    'Abierta',
  pending: 'Pendiente',
  closed:  'Cerrada',
}

const STATUS_COLOR: Record<string, string> = {
  open:    'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  closed:  'bg-gray-100 text-gray-600',
}

// ── Estado de asistencia (FASE 7B.1) ──────────────────────────────────────────
// Determina quién "tiene" la conversación en este momento: Génesis, un agente
// específico, o nadie todavía. El input de texto solo se habilita cuando el
// agente actual es dueño del chat (o es admin, que siempre puede escribir).
type ChatState = 'genesis' | 'mine' | 'other' | 'unassigned'

function getChatState(conv: WaConversation, currentUserId: string | null | undefined): ChatState {
  if (conv.assigned_to) return conv.assigned_to === currentUserId ? 'mine' : 'other'
  if (conv.ai_enabled)  return 'genesis'
  return 'unassigned'
}

function formatMsgTime(iso: string | null): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('es-DO', {
    timeZone: RD_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
}

function TemplateCard({ msg }: { msg: WaMessage }) {
  const m = msg.metadata as WaTemplateMetadata
  return (
    <div className="flex mb-2 justify-end">
      <div className="max-w-[75%] rounded-2xl rounded-tr-sm overflow-hidden shadow-sm border border-gray-200 bg-white text-sm">
        {m.header_image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={m.header_image_url}
            alt="Imagen del template"
            className="w-full max-h-56 object-cover"
          />
        )}
        {msg.body && (
          <p className="whitespace-pre-wrap break-words text-gray-900 px-3 pt-2.5 pb-2">
            {msg.body}
          </p>
        )}
        {m.buttons && m.buttons.length > 0 && (
          <div className="border-t border-gray-100">
            {m.buttons.map((btn, i) => (
              <div
                key={`${btn}-${i}`}
                className={cn(
                  'px-3 py-2 text-center text-sm font-medium text-indigo-600 select-none',
                  i > 0 && 'border-t border-gray-100',
                )}
              >
                {btn}
              </div>
            ))}
          </div>
        )}
        <p
          className="text-[10px] text-right text-gray-400 px-3 pb-1.5 pt-1"
          title={m.template_name ? `Template: ${m.template_name}` : undefined}
        >
          {m.template_name && (
            <span className="text-gray-300 mr-1.5">[{m.template_name}]</span>
          )}
          {formatMsgTime(msg.sent_at)}
        </p>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: WaMessage }) {
  if (msg.message_type === 'template' && msg.metadata) {
    return <TemplateCard msg={msg} />
  }
  const inbound = msg.direction === 'inbound'
  return (
    <div className={cn('flex mb-2', inbound ? 'justify-start' : 'justify-end')}>
      <div className={cn(
        'max-w-[75%] px-3 py-2 rounded-2xl text-sm',
        inbound
          ? 'bg-white text-gray-900 rounded-tl-sm shadow-sm'
          : 'bg-indigo-600 text-white rounded-tr-sm',
      )}>
        {msg.body ? (
          <p className="whitespace-pre-wrap break-words">{msg.body}</p>
        ) : (
          <p className={cn('italic text-xs', inbound ? 'text-gray-400' : 'text-indigo-200')}>
            [{msg.message_type}]
          </p>
        )}
        <p className={cn(
          'text-[10px] mt-1 text-right',
          inbound ? 'text-gray-400' : 'text-indigo-200',
        )}>
          {formatMsgTime(msg.sent_at)}
        </p>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

interface Props {
  conversation:     WaConversation | null
  messages:         WaMessage[]
  loading:          boolean
  messagesEndRef:   RefObject<HTMLDivElement | null>
  onBack?:          () => void
  onSend?:          (text: string) => Promise<void>
  currentUserId?:   string | null
  currentUserRole?: string | null
  agents?:          WaAgentOption[]
  onTake?:          (conv: WaConversation) => void
  onRelease?:       (conv: WaConversation) => void
  onAssign?:        (conv: WaConversation, assignedTo: string | null, aiEnabled: boolean) => void
}

export default function WaMessagePane({
  conversation, messages, loading, messagesEndRef, onBack, onSend,
  currentUserId, currentUserRole, agents = [], onTake, onRelease, onAssign,
}: Props) {
  const [text, setText]       = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const textareaRef           = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || sending || !onSend) return
    setSending(true)
    setSendError(null)
    try {
      await onSend(trimmed)
      setText('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'No se pudo enviar el mensaje.')
    } finally {
      setSending(false)
    }
  }, [text, sending, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 gap-3 text-gray-400">
        <MessageSquare className="w-12 h-12 opacity-20" />
        <p className="text-sm">Selecciona una conversación</p>
      </div>
    )
  }

  const contact   = conversation.contact
  const label     = contact.display_name?.trim() || contact.phone_normalized
  const statusKey = conversation.status

  const isAdmin    = currentUserRole === 'admin'
  const chatState  = getChatState(conversation, currentUserId)
  // Mientras Génesis asiste el chat (assigned_to=null, ai_enabled=true), el
  // input queda bloqueado para TODOS — incluido admin. Solo "Tomar chat"
  // (assigned_to=current_user, ai_enabled=false) habilita el composer.
  const canType    = chatState !== 'genesis' && (chatState === 'mine' || isAdmin)
  const agentName  = conversation.assigned_agent?.full_name?.trim() || 'otro agente'
  const assignValue = chatState === 'genesis' || chatState === 'unassigned'
    ? chatState
    : (conversation.assigned_to ?? 'unassigned')

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="h-14 flex-shrink-0 border-b border-gray-200 bg-white flex items-center px-4 gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="md:hidden p-1 -ml-1 text-gray-500 hover:text-gray-700"
            aria-label="Volver"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
          {label.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-gray-900 truncate">{label}</p>
          <p className="text-xs text-gray-400 truncate">{contact.phone_normalized}</p>
        </div>
        <span className={cn(
          'text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0',
          STATUS_COLOR[statusKey] ?? 'bg-gray-100 text-gray-600',
        )}>
          {STATUS_LABEL[statusKey] ?? statusKey}
        </span>

        {chatState === 'genesis' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-violet-100 text-violet-700">
            🤖 Génesis asistiendo
          </span>
        )}
        {chatState === 'mine' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-indigo-100 text-indigo-700">
            👤 Asignado a ti
          </span>
        )}
        {chatState === 'other' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-amber-100 text-amber-700">
            👤 Asignado a {agentName}
          </span>
        )}
        {chatState === 'unassigned' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-gray-100 text-gray-600">
            Sin asignar
          </span>
        )}

        {chatState === 'mine' && onRelease && (
          <button
            onClick={() => onRelease(conversation)}
            className="text-xs px-3 py-1 rounded-full bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors flex-shrink-0"
          >
            Liberar
          </button>
        )}

        {onAssign && (
          <select
            value={assignValue}
            onChange={e => {
              const v = e.target.value
              if (v === 'genesis')         onAssign(conversation, null, true)
              else if (v === 'unassigned') onAssign(conversation, null, false)
              else                          onAssign(conversation, v, false)
            }}
            className="text-xs border border-gray-200 rounded-full px-2 py-1 bg-white text-gray-600
                       focus:outline-none focus:ring-1 focus:ring-indigo-500 flex-shrink-0 max-w-[140px]"
          >
            <option value="genesis">🤖 Génesis</option>
            <option value="unassigned">Sin asignar / manual</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.full_name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
        {loading ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-400">
            Sin mensajes
          </div>
        ) : (
          messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="flex-shrink-0 border-t border-gray-200 bg-white px-3 py-2">
        {canType ? (
          <>
            {sendError && (
              <p className="text-xs text-red-600 mb-1.5 px-1">{sendError}</p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="Escribe un mensaje..."
                disabled={sending}
                rows={1}
                className={cn(
                  'flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm',
                  'min-h-[36px] max-h-[96px] overflow-y-auto',
                  'focus:outline-none focus:ring-1 focus:ring-indigo-500',
                  'placeholder:text-gray-400 disabled:opacity-50',
                )}
              />
              <button
                onClick={handleSend}
                disabled={!text.trim() || sending}
                aria-label="Enviar"
                className={cn(
                  'flex-shrink-0 rounded-lg bg-indigo-600 p-2 text-white',
                  'hover:bg-indigo-700 transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <BlockedComposeBanner
            chatState={chatState}
            agentName={agentName}
            onTake={onTake ? () => onTake(conversation) : undefined}
          />
        )}
      </div>
    </div>
  )
}

// ── Banner que reemplaza la caja de texto cuando el agente actual no puede
// escribir todavía (chat asistido por Génesis, asignado a otro, o sin tomar).
function BlockedComposeBanner({
  chatState, agentName, onTake,
}: {
  chatState: ChatState
  agentName: string
  onTake?: () => void
}) {
  if (chatState === 'other') {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-sm text-gray-500">
        <span>Asignado a {agentName}.</span>
      </div>
    )
  }

  const text = chatState === 'genesis'
    ? 'Génesis está asistiendo este chat. Toma la conversación para responder manualmente.'
    : 'Nadie está atendiendo este chat todavía.'

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-1">
      <p className="text-sm text-gray-500">{text}</p>
      {onTake && (
        <button
          onClick={onTake}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-full bg-indigo-600 text-white
                     hover:bg-indigo-700 transition-colors"
        >
          Tomar chat
        </button>
      )}
    </div>
  )
}
