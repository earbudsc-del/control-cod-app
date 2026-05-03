'use client'

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import type { AgentPerformance, Profile } from '@/types'
import {
  BarChart2, Users, Phone, CheckCircle2, Calendar,
  RotateCcw, ShieldAlert, AlertTriangle, FileText, Clock,
} from 'lucide-react'

function MetricCard({
  label, value, icon: Icon, color = 'text-gray-600', bg = 'bg-gray-50',
}: {
  label: string; value: number
  icon: React.ElementType; color?: string; bg?: string
}) {
  return (
    <div className={`${bg} rounded-xl p-4 flex items-center gap-3`}>
      <Icon className={`w-5 h-5 shrink-0 ${color}`} />
      <div>
        <p className="text-xl font-bold text-gray-900">{value.toLocaleString()}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  )
}

export default function PerformancePage() {
  const [agents, setAgents]       = useState<AgentPerformance[]>([])
  const [profiles, setProfiles]   = useState<Profile[]>([])
  const [selected, setSelected]   = useState<string>('')
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/performance').then(r => r.json()),
      fetch('/api/profiles').then(r => r.json()),
    ]).then(([perf, profs]) => {
      setAgents(perf ?? [])
      setProfiles(profs ?? [])
      setLoading(false)
    })
  }, [])

  const filtered = selected ? agents.filter(a => a.agent_id === selected) : agents

  function effectiveness(a: AgentPerformance) {
    if (!a.pedidos_asignados) return 0
    return Math.round((a.pedidos_entregados / a.pedidos_asignados) * 100)
  }

  function contactRate(a: AgentPerformance) {
    if (!a.pedidos_asignados) return 0
    return Math.round((a.pedidos_contactados / a.pedidos_asignados) * 100)
  }

  const selectedAgent = selected ? agents.find(a => a.agent_id === selected) : null

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8 text-blue-600" />
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Rendimiento de Agentes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Métricas de seguimiento y gestión por agente</p>
        </div>
        <div className="flex gap-3">
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Todos los agentes</option>
            {profiles.filter(p => p.role !== 'viewer').map(p => (
              <option key={p.id} value={p.id}>{p.full_name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Perfil individual si hay agente seleccionado */}
      {selectedAgent && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <span className="text-blue-700 font-bold text-sm">
                  {selectedAgent.agent_name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div>
                <p className="font-semibold text-gray-900">{selectedAgent.agent_name}</p>
                <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                  <span>Efectividad: <strong className="text-green-600">{effectiveness(selectedAgent)}%</strong></span>
                  <span>Contacto: <strong className="text-blue-600">{contactRate(selectedAgent)}%</strong></span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <MetricCard label="Asignados"    value={selectedAgent.pedidos_asignados}    icon={Users}         bg="bg-blue-50"   color="text-blue-600" />
              <MetricCard label="Contactados"  value={selectedAgent.pedidos_contactados}  icon={Phone}         bg="bg-indigo-50" color="text-indigo-600" />
              <MetricCard label="Confirmados"  value={selectedAgent.pedidos_confirmados}  icon={CheckCircle2}  bg="bg-green-50"  color="text-green-600" />
              <MetricCard label="Reprogramados"value={selectedAgent.pedidos_reprogramados}icon={Calendar}      bg="bg-gray-50"   color="text-gray-600" />
              <MetricCard label="Recuperados"  value={selectedAgent.pedidos_recuperados}  icon={ShieldAlert}   bg="bg-cyan-50"   color="text-cyan-600" />
              <MetricCard label="Entregados"   value={selectedAgent.pedidos_entregados}   icon={CheckCircle2}  bg="bg-green-50"  color="text-green-700" />
              <MetricCard label="Devueltos"    value={selectedAgent.pedidos_devueltos}    icon={RotateCcw}     bg="bg-red-50"    color="text-red-600" />
              <MetricCard label="SLA vencidos" value={selectedAgent.sla_incumplidos}      icon={Clock}         bg="bg-red-50"    color="text-red-700" />
              <MetricCard label="Sin acción >24h" value={selectedAgent.sin_accion_24h}    icon={AlertTriangle} bg="bg-amber-50"  color="text-amber-600" />
              <MetricCard label="Reclamos courier" value={selectedAgent.reclamos_courier} icon={ShieldAlert}   bg="bg-orange-50" color="text-orange-600" />
              <MetricCard label="Notas registradas" value={selectedAgent.notas_registradas} icon={FileText}    bg="bg-gray-50"   color="text-gray-500" />
            </div>
          </div>
        </div>
      )}

      {/* Tabla comparativa */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900 text-sm">
            {selected ? 'Detalle del agente' : 'Comparativa del equipo'}
          </h2>
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Users className="w-8 h-8 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">Sin datos de agentes</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {[
                    'Agente','Asignados','Contactados','Confirmados',
                    'Recuperados','Entregados','Devueltos',
                    'SLA ⚠','Sin acción','Reclamos','Efectividad',
                  ].map(h => (
                    <th key={h} className="px-3 py-3 text-left font-medium text-gray-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(a => (
                  <tr
                    key={a.agent_id}
                    className={`hover:bg-gray-50 cursor-pointer ${a.sin_accion_24h > 0 ? 'bg-amber-50/40' : ''}`}
                    onClick={() => setSelected(a.agent_id === selected ? '' : a.agent_id)}
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                          <span className="text-blue-700 font-bold text-xs">{a.agent_name.charAt(0)}</span>
                        </div>
                        <span className="font-medium text-gray-800">{a.agent_name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-gray-700 font-medium">{a.pedidos_asignados}</td>
                    <td className="px-3 py-3 text-gray-600">{a.pedidos_contactados}</td>
                    <td className="px-3 py-3 text-green-700 font-medium">{a.pedidos_confirmados}</td>
                    <td className="px-3 py-3 text-cyan-700">{a.pedidos_recuperados}</td>
                    <td className="px-3 py-3 text-green-700 font-semibold">{a.pedidos_entregados}</td>
                    <td className="px-3 py-3 text-red-600">{a.pedidos_devueltos}</td>
                    <td className="px-3 py-3">
                      {a.sla_incumplidos > 0
                        ? <span className="text-red-600 font-semibold">{a.sla_incumplidos}</span>
                        : <span className="text-gray-300">0</span>}
                    </td>
                    <td className="px-3 py-3">
                      {a.sin_accion_24h > 0
                        ? <span className="text-amber-600 font-semibold">{a.sin_accion_24h}</span>
                        : <span className="text-gray-300">0</span>}
                    </td>
                    <td className="px-3 py-3 text-orange-600">{a.reclamos_courier}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-gray-100 rounded-full h-1.5">
                          <div
                            className="bg-green-500 h-1.5 rounded-full"
                            style={{ width: `${effectiveness(a)}%` }}
                          />
                        </div>
                        <span className="text-gray-700 font-medium">{effectiveness(a)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pedidos sin acción */}
      {agents.some(a => a.sin_accion_24h > 0) && !selected && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            <h3 className="font-semibold text-amber-900 text-sm">Pedidos sin acción (&gt;24h)</h3>
          </div>
          <div className="flex flex-wrap gap-3">
            {agents.filter(a => a.sin_accion_24h > 0).map(a => (
              <button
                key={a.agent_id}
                onClick={() => setSelected(a.agent_id)}
                className="flex items-center gap-2 bg-white border border-amber-200 rounded-lg px-3 py-2 text-sm hover:border-amber-400 transition-colors"
              >
                <span className="font-medium text-gray-800">{a.agent_name}</span>
                <span className="font-bold text-amber-600">{a.sin_accion_24h}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
