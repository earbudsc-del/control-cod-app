'use client'

import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WaConversation } from './types'

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

interface Props {
  conversations: WaConversation[]
  selectedId:    string | null
  loading:       boolean
  onSelect:      (conv: WaConversation) => void
}

export default function WaConversationList({ conversations, selectedId, loading, onSelect }: Props) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex-shrink-0 bg-white">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-green-600" />
          <h1 className="font-semibold text-gray-900 text-sm">Inbox WhatsApp</h1>
        </div>
        {!loading && (
          <p className="text-xs text-gray-400 mt-0.5">
            {conversations.length} conversacion{conversations.length !== 1 ? 'es' : ''}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-white">
        {loading ? (
          <ConvSkeleton />
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400">
            <MessageSquare className="w-8 h-8 opacity-25" />
            <span className="text-sm">Sin conversaciones</span>
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
                      {conv.last_message_preview ?? 'Sin mensajes'}
                    </p>
                    {conv.unread_count > 0 && (
                      <span className="flex-shrink-0 min-w-[18px] h-[18px] rounded-full bg-green-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
                        {conv.unread_count > 99 ? '99+' : conv.unread_count}
                      </span>
                    )}
                  </div>

                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {conv.contact.phone_normalized}
                  </p>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
