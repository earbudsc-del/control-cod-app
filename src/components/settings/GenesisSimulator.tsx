'use client'

import { useState, useRef, useEffect } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { FlaskConical, RotateCcw, Send, AlertTriangle, Info, ShieldAlert } from 'lucide-react'

type Role = 'user' | 'assistant'

interface SimMessage {
  role:    Role
  content: string
}

interface SimResponse {
  reply:        string | null
  blocked:      boolean
  blockReasons: string[]
  warnings:     string[]
  escalation:   { required: boolean; reason: string | null }
  model:        string
  latencyMs:    number
  usage:        { inputTokens: number; outputTokens: number } | null
  error?:       string
  detail?:      string
  kind?:        string
}

interface Scenario {
  id:      string
  label:   string
  message: string
}

const SCENARIOS: Scenario[] = [
  { id: 'libre',         label: 'Conversación libre', message: '' },
  { id: 'precio',        label: 'Precio',             message: '¿Cuánto cuesta?' },
  { id: 'sensibilidad',  label: 'Sensibilidad',       message: 'Tengo los dientes muy sensibles, ¿me sirve esto?' },
  { id: 'objecion',      label: 'Objeción',           message: 'Está muy caro, no sé si comprarlo.' },
  { id: 'autenticidad',  label: 'Autenticidad',       message: '¿Cómo sé que es original?' },
  { id: 'confirmacion',  label: 'Confirmación',       message: 'Sí, quiero pedirlo.' },
  { id: 'cancelacion',   label: 'Cancelación',        message: 'En realidad ya no lo quiero.' },
  { id: 'escalamiento',  label: 'Escalamiento',       message: 'Me provocó una reacción extraña y me duele mucho.' },
]

export default function GenesisSimulator() {
  const [messages, setMessages]   = useState<SimMessage[]>([])
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [lastMeta, setLastMeta]   = useState<SimResponse | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [scenarioId, setScenarioId] = useState('libre')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  function reset() {
    setMessages([])
    setInput('')
    setLastMeta(null)
    setError(null)
  }

  function applyScenario(id: string) {
    setScenarioId(id)
    const scenario = SCENARIOS.find(s => s.id === id)
    if (scenario && scenario.message) setInput(scenario.message)
  }

  async function send() {
    const text = input.trim()
    if (!text || sending) return

    const nextHistory = [...messages, { role: 'user' as const, content: text }]
    setMessages(nextHistory)
    setInput('')
    setSending(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/genesis-simulator/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: messages, message: text }),
      })
      const data = await res.json() as SimResponse

      if (!res.ok) {
        setError(data.error ?? 'Error desconocido del Laboratorio')
        setLastMeta(data)
        return
      }

      setLastMeta(data)
      if (data.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply as string }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
        <ShieldAlert className="w-4 h-4 shrink-0" />
        Modo simulación — no se envían mensajes por WhatsApp. Esta conversación no existe en el Inbox real.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <FlaskConical className="w-4 h-4 text-violet-500 shrink-0" />
        <span className="text-sm font-semibold text-gray-900">Laboratorio de Génesis</span>

        <select
          value={scenarioId}
          onChange={e => applyScenario(e.target.value)}
          className="ml-auto text-xs border border-gray-200 rounded-lg px-2 py-1.5
                     focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
        >
          {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>

        <button
          onClick={reset}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                     border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reiniciar conversación
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="h-96 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-10">
              Escribe un mensaje o elige un escenario rápido para empezar.
            </p>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap
                ${m.role === 'user' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-900'}`}
              >
                <p className="text-[10px] font-medium mb-0.5 opacity-60">
                  {m.role === 'user' ? 'Cliente' : 'Génesis'}
                </p>
                {m.content}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-2xl px-3.5 py-2">
                <Spinner className="w-4 h-4 text-gray-400" />
              </div>
            </div>
          )}

          {lastMeta?.blocked && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Bloqueado por el validador — no se habría enviado nada al cliente.</p>
                <ul className="list-disc list-inside mt-1">
                  {lastMeta.blockReasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            </div>
          )}

          {lastMeta?.escalation?.required && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-50 border border-orange-200 text-orange-700 text-xs font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              [Escalamiento requerido] — en producción, esta conversación se marcaría como escalada tras enviarse (reason: {lastMeta.escalation.reason}). El Laboratorio no ejecuta esa acción real.
            </div>
          )}

          {error && !lastMeta?.blocked && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="border-t border-gray-100 p-3 flex items-center gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Escribe como si fueras el cliente..."
            disabled={sending}
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2
                       focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-gray-50"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium
                       bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" /> Enviar
          </button>
        </div>
      </div>

      {lastMeta && !lastMeta.error && (
        <div className="flex items-center gap-3 flex-wrap px-1 text-[11px] text-gray-400">
          <span className="flex items-center gap-1"><Info className="w-3 h-3" /> {lastMeta.model}</span>
          <span>{lastMeta.latencyMs} ms</span>
          {lastMeta.usage && (
            <span>{lastMeta.usage.inputTokens} in / {lastMeta.usage.outputTokens} out tokens</span>
          )}
          {lastMeta.warnings.length > 0 && (
            <span className="text-amber-500">⚠ {lastMeta.warnings.length} advertencia(s) (ver consola)</span>
          )}
        </div>
      )}
    </div>
  )
}
