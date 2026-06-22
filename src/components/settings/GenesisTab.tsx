'use client'

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import type { AiAgentConfig, AiAgentMode, AiKnowledgeSection, AiProvider } from '@/types'
import {
  Bot, Cpu, FileText, BookOpen, ShieldCheck, Power,
  CheckCircle2, AlertCircle, Plus, ChevronDown, ChevronUp,
} from 'lucide-react'

type SubTab = 'perfil' | 'proveedor' | 'prompt' | 'conocimiento' | 'reglas' | 'modo'

const SUB_TABS: { id: SubTab; label: string; icon: React.ElementType }[] = [
  { id: 'perfil',       label: 'Perfil',             icon: Bot },
  { id: 'proveedor',    label: 'Proveedor',          icon: Cpu },
  { id: 'prompt',       label: 'Prompt',             icon: FileText },
  { id: 'conocimiento', label: 'Base de conocimiento', icon: BookOpen },
  { id: 'reglas',       label: 'Reglas operativas',  icon: ShieldCheck },
  { id: 'modo',         label: 'Modo de operación',  icon: Power },
]

const MODE_OPTIONS: { value: AiAgentMode; label: string; description: string }[] = [
  { value: 'off',          label: 'Apagado',       description: 'Génesis no interviene en ninguna conversación.' },
  { value: 'suggest',      label: 'Sugerir',        description: 'Génesis prepara una respuesta sugerida para que el agente la apruebe. (No implementado todavía)' },
  { value: 'auto',         label: 'Automático',     description: 'Génesis responde directamente al cliente. (No implementado todavía)' },
  { value: 'after_hours',  label: 'Fuera de horario', description: 'Génesis solo interviene fuera del horario operativo. (No implementado todavía)' },
]

const RULES_KEYS = new Set(['reglas_cod', 'objeciones', 'politica_entrega', 'escalamiento'])

function slugify(label: string): string {
  return label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export default function GenesisTab() {
  const [subTab, setSubTab]   = useState<SubTab>('perfil')
  const [config, setConfig]   = useState<AiAgentConfig | null>(null)
  const [sections, setSections] = useState<AiKnowledgeSection[]>([])
  const [loading, setLoading] = useState(true)
  const [saved, setSaved]     = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/settings/ai-agent').then(r => r.json()),
      fetch('/api/settings/ai-agent/knowledge').then(r => r.json()),
    ]).then(([cfg, secs]) => {
      setConfig(cfg?.error ? null : cfg)
      setSections(Array.isArray(secs) ? secs : [])
      setLoading(false)
    })
  }, [])

  function flashSaved(ok: boolean) {
    if (ok) { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    else     { setSaveError(true); setTimeout(() => setSaveError(false), 3000) }
  }

  async function patchConfig(updates: Partial<AiAgentConfig>) {
    const res = await fetch('/api/settings/ai-agent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setConfig(data)
      flashSaved(true)
    } else {
      flashSaved(false)
    }
  }

  async function patchSection(id: string, updates: Partial<AiKnowledgeSection>) {
    const res = await fetch(`/api/settings/ai-agent/knowledge/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setSections(prev => prev.map(s => s.id === id ? data : s))
      flashSaved(true)
    } else {
      flashSaved(false)
    }
  }

  async function createSection(label: string) {
    const section_key = slugify(label)
    if (!section_key) return
    const res = await fetch('/api/settings/ai-agent/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_key, label, priority: 0, is_active: true }),
    })
    if (res.ok) {
      const data = await res.json()
      setSections(prev => [data, ...prev])
      flashSaved(true)
    } else {
      flashSaved(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8 text-blue-600" />
    </div>
  )

  if (!config) return (
    <p className="px-5 py-8 text-sm text-gray-400 text-center">
      No se pudo cargar la configuración de Génesis IA.
    </p>
  )

  const knowledgeSections = sections.filter(s => !RULES_KEYS.has(s.section_key))
  const rulesSections     = sections.filter(s => RULES_KEYS.has(s.section_key))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Bot className="w-5 h-5 text-violet-500" />
        <div>
          <h2 className="text-base font-semibold text-gray-900">{config.agent_name || 'Génesis'}</h2>
          <p className="text-xs text-gray-500">Agente IA configurable — sin conexión activa todavía</p>
        </div>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 ml-auto">
            <CheckCircle2 className="w-4 h-4" /> Guardado
          </span>
        )}
        {saveError && (
          <span className="flex items-center gap-1 text-sm text-red-600 ml-auto">
            <AlertCircle className="w-4 h-4" /> Error al guardar
          </span>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
        {SUB_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSubTab(id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${subTab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Perfil */}
      {subTab === 'perfil' && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4 max-w-xl">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Nombre del agente</label>
            <input
              defaultValue={config.agent_name}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-violet-500"
              onBlur={e => {
                const name = e.target.value.trim()
                if (name && name !== config.agent_name) patchConfig({ agent_name: name })
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Activo</p>
              <p className="text-xs text-gray-500">Controla si Génesis está habilitado para esta tienda.</p>
            </div>
            <button
              onClick={() => patchConfig({ is_active: !config.is_active })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${config.is_active ? 'bg-violet-600' : 'bg-gray-300'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                ${config.is_active ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Proveedor */}
      {subTab === 'proveedor' && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4 max-w-xl">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Proveedor</label>
            <select
              value={config.provider ?? ''}
              onChange={e => patchConfig({ provider: (e.target.value || null) as AiProvider | null })}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
            >
              <option value="">Sin definir</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Modelo</label>
            <input
              defaultValue={config.model ?? ''}
              placeholder="ej. gpt-4o-mini, gemini-1.5-flash"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-violet-500"
              onBlur={e => {
                const model = e.target.value.trim()
                if (model !== (config.model ?? '')) patchConfig({ model: model || null })
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Referencia de API key</label>
            <input
              defaultValue={config.api_key_ref ?? ''}
              placeholder="ej. GENESIS_OPENAI_KEY"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 font-mono
                         focus:outline-none focus:ring-2 focus:ring-violet-500"
              onBlur={e => {
                const ref = e.target.value.trim()
                if (ref !== (config.api_key_ref ?? '')) patchConfig({ api_key_ref: ref || null })
              }}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Solo el nombre de la variable de entorno. La API key real se configura en Vercel, nunca aquí.
            </p>
          </div>
        </div>
      )}

      {/* Prompt */}
      {subTab === 'prompt' && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 max-w-2xl">
          <label className="block text-xs font-medium text-gray-500 mb-1">System prompt</label>
          <textarea
            defaultValue={config.system_prompt ?? ''}
            rows={12}
            placeholder="Instrucciones principales que definen el comportamiento de Génesis..."
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 font-mono
                       focus:outline-none focus:ring-2 focus:ring-violet-500"
            onBlur={e => {
              const prompt = e.target.value
              if (prompt !== (config.system_prompt ?? '')) patchConfig({ system_prompt: prompt || null })
            }}
          />
        </div>
      )}

      {/* Base de conocimiento */}
      {subTab === 'conocimiento' && (
        <KnowledgeGroup
          title="Base de conocimiento"
          description="Información de productos, ofertas, cobertura y validaciones que Génesis usará para responder."
          sections={knowledgeSections}
          onPatch={patchSection}
          onCreate={createSection}
        />
      )}

      {/* Reglas operativas */}
      {subTab === 'reglas' && (
        <KnowledgeGroup
          title="Reglas operativas"
          description="Reglas COD, objeciones frecuentes, política de entrega y cuándo escalar a un humano."
          sections={rulesSections}
          onPatch={patchSection}
          onCreate={createSection}
        />
      )}

      {/* Modo de operación */}
      {subTab === 'modo' && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 max-w-xl space-y-2">
          {MODE_OPTIONS.map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
                ${config.mode === opt.value ? 'border-violet-400 bg-violet-50' : 'border-gray-200 hover:bg-gray-50'}`}
            >
              <input
                type="radio"
                name="ai-mode"
                checked={config.mode === opt.value}
                onChange={() => patchConfig({ mode: opt.value })}
                className="mt-1"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                <p className="text-xs text-gray-500">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Subcomponente: lista editable de secciones (conocimiento o reglas) ────────

function KnowledgeGroup({
  title, description, sections, onPatch, onCreate,
}: {
  title: string
  description: string
  sections: AiKnowledgeSection[]
  onPatch: (id: string, updates: Partial<AiKnowledgeSection>) => Promise<void>
  onCreate: (label: string) => Promise<void>
}) {
  const [newLabel, setNewLabel] = useState('')
  const [creating, setCreating] = useState(false)

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden max-w-3xl">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="Nueva sección..."
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-44
                       focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button
            disabled={!newLabel.trim() || creating}
            onClick={async () => {
              setCreating(true)
              await onCreate(newLabel.trim())
              setNewLabel('')
              setCreating(false)
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium
                       bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" /> Crear
          </button>
        </div>
      </div>

      {sections.length === 0 ? (
        <p className="px-5 py-8 text-sm text-gray-400 text-center">Sin secciones todavía.</p>
      ) : (
        <div className="divide-y divide-gray-50">
          {sections.map(section => (
            <SectionRow key={section.id} section={section} onPatch={onPatch} />
          ))}
        </div>
      )}
    </div>
  )
}

function SectionRow({
  section, onPatch,
}: {
  section: AiKnowledgeSection
  onPatch: (id: string, updates: Partial<AiKnowledgeSection>) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`px-5 py-3 ${!section.is_active ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-3">
        <button onClick={() => setExpanded(v => !v)} className="text-gray-400 hover:text-gray-600">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <input
          defaultValue={section.label}
          className="flex-1 text-sm font-medium text-gray-900 bg-transparent border-b border-transparent
                     hover:border-gray-200 focus:border-violet-400 focus:outline-none px-1 py-0.5"
          onBlur={e => {
            const label = e.target.value.trim()
            if (label && label !== section.label) onPatch(section.id, { label })
          }}
        />

        <span className="text-[10px] font-mono text-gray-300">{section.section_key}</span>

        <input
          type="number"
          defaultValue={section.priority}
          title="Prioridad"
          className="w-14 text-center text-xs border border-gray-200 rounded-lg px-1.5 py-1
                     focus:outline-none focus:ring-2 focus:ring-violet-500"
          onBlur={e => {
            const priority = parseInt(e.target.value, 10)
            if (!isNaN(priority) && priority !== section.priority) onPatch(section.id, { priority })
          }}
        />

        <button
          onClick={() => onPatch(section.id, { is_active: !section.is_active })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
            ${section.is_active ? 'bg-violet-600' : 'bg-gray-300'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform
            ${section.is_active ? 'translate-x-4' : 'translate-x-1'}`} />
        </button>
      </div>

      {expanded && (
        <textarea
          defaultValue={section.content ?? ''}
          rows={5}
          placeholder="Contenido de esta sección..."
          className="mt-2 w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                     focus:outline-none focus:ring-2 focus:ring-violet-500"
          onBlur={e => {
            const content = e.target.value
            if (content !== (section.content ?? '')) onPatch(section.id, { content: content || null } as Partial<AiKnowledgeSection>)
          }}
        />
      )}
    </div>
  )
}
