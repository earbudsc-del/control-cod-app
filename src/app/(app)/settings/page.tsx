'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { Profile, SlaRule, StatusPattern } from '@/types'
import { Settings, Users, Clock, List, Save, CheckCircle2 } from 'lucide-react'

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'admin',              label: 'Administrador'          },
  { value: 'ia_supervisor',      label: 'Supervisor IA'          },
  { value: 'confirmation_agent', label: 'Agente de confirmación' },
  { value: 'novelty_agent',      label: 'Agente de novedades'    },
  { value: 'delivery_agent',     label: 'Agente de reparto'      },
  { value: 'agent',              label: 'Agente general'         },
  { value: 'viewer',             label: 'Solo lectura'           },
]

type Tab = 'users' | 'sla' | 'patterns'

export default function SettingsPage() {
  const [tab, setTab]             = useState<Tab>('users')
  const [profiles, setProfiles]   = useState<Profile[]>([])
  const [slaRules, setSlaRules]   = useState<SlaRule[]>([])
  const [patterns, setPatterns]   = useState<StatusPattern[]>([])
  const [loading, setLoading]     = useState(true)
  const [saved, setSaved]         = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/profiles').then(r => r.json()),
      fetch('/api/settings/sla').then(r => r.json()).catch(() => []),
      fetch('/api/settings/patterns').then(r => r.json()).catch(() => []),
    ]).then(([profs, sla, pats]) => {
      setProfiles(profs ?? [])
      setSlaRules(sla ?? [])
      setPatterns(pats ?? [])
      setLoading(false)
    })
  }, [])

  async function handleSaveRole(id: string, role: string, full_name: string) {
    await fetch('/api/profiles', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, role, full_name }),
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const TABS = [
    { id: 'users',    label: 'Usuarios',       icon: Users },
    { id: 'sla',      label: 'Reglas de SLA',   icon: Clock },
    { id: 'patterns', label: 'Patrones EFI',    icon: List },
  ] as const

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8 text-blue-600" />
    </div>
  )

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Settings className="w-5 h-5 text-gray-400" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Configuración</h1>
          <p className="text-sm text-gray-500 mt-0.5">Gestión de usuarios, SLA y patrones de estado</p>
        </div>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 ml-auto">
            <CheckCircle2 className="w-4 h-4" /> Guardado
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
              ${tab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab: Usuarios */}
      {tab === 'users' && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="text-sm text-gray-500">
              Los usuarios se crean desde el{' '}
              <strong>Dashboard de Supabase Auth</strong>.
              Aquí puedes cambiar roles y nombres.
            </p>
          </div>
          <div className="divide-y divide-gray-50">
            {profiles.map(profile => (
              <div key={profile.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                  <span className="text-blue-700 font-bold text-sm">
                    {profile.full_name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  <input
                    defaultValue={profile.full_name}
                    className="text-sm font-medium text-gray-900 bg-transparent border-b border-transparent
                               hover:border-gray-200 focus:border-blue-400 focus:outline-none px-1 py-0.5 w-full"
                    onBlur={e => handleSaveRole(profile.id, profile.role, e.target.value)}
                  />
                </div>
                <select
                  defaultValue={profile.role}
                  onChange={e => handleSaveRole(profile.id, e.target.value, profile.full_name)}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-1.5
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ROLE_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: SLA */}
      {tab === 'sla' && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="text-sm text-gray-500">
              Horas máximas de inacción antes de marcar SLA vencido.
            </p>
          </div>
          {slaRules.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-400 text-center">
              No hay reglas SLA. Ejecuta el seed SQL en Supabase.
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {slaRules.map(rule => (
                <div key={rule.id} className="flex items-center gap-4 px-5 py-4">
                  <div className={`px-2 py-0.5 rounded-full text-xs font-medium
                    ${rule.classification === 'critical'  ? 'bg-red-100 text-red-700' :
                      rule.classification === 'urgent'    ? 'bg-orange-100 text-orange-700' :
                      rule.classification === 'claim'     ? 'bg-purple-100 text-purple-700' :
                                                            'bg-blue-100 text-blue-700'}`}>
                    {rule.classification === 'critical'  ? 'Crítico' :
                     rule.classification === 'urgent'    ? 'Urgente' :
                     rule.classification === 'claim'     ? 'Reclamo' : 'Seguimiento'}
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      defaultValue={rule.max_inaction_hours}
                      min={1}
                      max={168}
                      className="w-16 text-center text-sm border border-gray-200 rounded-lg px-2 py-1.5
                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      onBlur={async e => {
                        const hours = parseInt(e.target.value)
                        if (isNaN(hours)) return
                        await fetch('/api/settings/sla', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id: rule.id, max_inaction_hours: hours }),
                        })
                        setSaved(true)
                        setTimeout(() => setSaved(false), 2000)
                      }}
                    />
                    <span className="text-sm text-gray-500">horas</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Patrones */}
      {tab === 'patterns' && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="text-sm text-gray-500">
              Textos que el sistema detecta en el estado EFI para normalizar el pedido.
              Ordenados por prioridad descendente.
            </p>
          </div>
          {patterns.length === 0 ? (
            <p className="px-5 py-8 text-sm text-gray-400 text-center">
              No hay patrones. Ejecuta el seed SQL en Supabase.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['Patrón de texto','Estado normalizado','+ Intento','Activa riesgo','Prioridad'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {[...patterns].sort((a, b) => b.priority - a.priority).map(p => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{p.pattern}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium
                          ${p.normalized_status === 'delivered'     ? 'bg-green-100 text-green-700' :
                            p.normalized_status === 'returned'      ? 'bg-red-100 text-red-700' :
                            p.normalized_status === 'failed_attempt'? 'bg-amber-100 text-amber-700' :
                            p.normalized_status === 'in_transit'    ? 'bg-blue-100 text-blue-700' :
                            p.normalized_status === 'out_for_delivery' ? 'bg-indigo-100 text-indigo-700' :
                                                                      'bg-gray-100 text-gray-600'}`}>
                          {p.normalized_status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-600">{p.attempt_increment || '—'}</td>
                      <td className="px-4 py-2.5 text-center">
                        {p.is_at_risk_trigger
                          ? <span className="text-red-500 font-bold">Sí</span>
                          : <span className="text-gray-300">No</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-500 font-mono">{p.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
