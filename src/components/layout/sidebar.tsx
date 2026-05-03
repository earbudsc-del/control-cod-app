'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard, Package, Upload, BarChart2,
  Settings, LogOut, Truck, Bike, AlertCircle, ClipboardList,
  ListTodo, TrendingUp, Box, CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

type AlertColor = 'amber' | 'red' | 'indigo' | 'green' | null

interface NavItem {
  href:  string
  label: string
  icon:  React.ElementType
  alert: AlertColor
}

// ─── Configuración de navegación por rol ────────────────────────────────────

const NAV_BY_ROLE: Record<string, NavItem[]> = {

  admin: [
    { href: '/dashboard',    label: 'Dashboard',      icon: LayoutDashboard, alert: null     },
    { href: '/reparto',      label: 'En Reparto',     icon: Bike,            alert: 'amber'  },
    { href: '/novedad',      label: 'Novedades',      icon: AlertCircle,     alert: 'red'    },
    { href: '/transito',     label: 'Tránsito',       icon: Box,             alert: null     },
    { href: '/confirmacion', label: 'Confirmación',   icon: ClipboardList,   alert: 'indigo' },
    { href: '/confirmados',  label: 'Confirmados',    icon: CheckCircle2,    alert: 'green'  },
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
    { href: '/imports',      label: 'Importar',       icon: Upload,          alert: null     },
    { href: '/performance',  label: 'Rendimiento',    icon: BarChart2,       alert: null     },
    { href: '/settings',     label: 'Configuración',  icon: Settings,        alert: null     },
  ],

  ia_supervisor: [
    { href: '/dashboard',    label: 'Dashboard',      icon: LayoutDashboard, alert: null     },
    { href: '/my-tasks',     label: 'Mis tareas',     icon: ListTodo,        alert: null     },
    { href: '/transito',     label: 'Tránsito',       icon: Box,             alert: null     },
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
  ],

  confirmation_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp,    alert: null     },
    { href: '/confirmacion',   label: 'Confirmaciones', icon: ClipboardList, alert: 'indigo' },
  ],

  novelty_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp,  alert: null     },
    { href: '/novedad',        label: 'Novedades',      icon: AlertCircle, alert: 'red'    },
    { href: '/transito',       label: 'Tránsito',       icon: Box,         alert: null     },
  ],

  delivery_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp, alert: null    },
    { href: '/reparto',        label: 'En Reparto',     icon: Bike,       alert: 'amber' },
    { href: '/transito',       label: 'Tránsito',       icon: Box,        alert: null    },
  ],

  // Fallback para role = 'agent' (usuarios migrados sin rol especializado)
  agent: [
    { href: '/my-tasks',     label: 'Mis tareas',     icon: ListTodo,        alert: null     },
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
  ],

  // viewer: solo lectura, acceso mínimo
  viewer: [
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
  ],
}

// ─── Componente ─────────────────────────────────────────────────────────────

interface SidebarProps {
  role: UserRole | string
}

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname()
  const router   = useRouter()

  const nav = NAV_BY_ROLE[role] ?? NAV_BY_ROLE['agent']

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <aside className="fixed inset-y-0 left-0 w-56 bg-gray-900 flex flex-col z-30">

      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-gray-800">
        <div className="flex items-center justify-center w-8 h-8 bg-blue-600 rounded-lg shrink-0">
          <Truck className="w-4 h-4 text-white" />
        </div>
        <span className="text-white font-semibold text-sm">Control COD</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto scrollbar-thin">
        {nav.map(({ href, label, icon: Icon, alert }) => {
          const active   = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          const isAmber  = alert === 'amber'
          const isRed    = alert === 'red'
          const isIndigo = alert === 'indigo'
          const isGreen  = alert === 'green'

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                active && isAmber  && 'bg-amber-700/50 text-amber-200',
                active && isRed    && 'bg-red-900/50 text-red-200',
                active && isIndigo && 'bg-indigo-700/50 text-indigo-200',
                active && isGreen  && 'bg-green-700/50 text-green-200',
                active && !alert   && 'bg-gray-700 text-white',
                !active && isAmber  && 'text-amber-400 hover:bg-amber-900/30 hover:text-amber-300',
                !active && isRed    && 'text-red-400 hover:bg-red-900/30 hover:text-red-300',
                !active && isIndigo && 'text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300',
                !active && isGreen  && 'text-green-400 hover:bg-green-900/30 hover:text-green-300',
                !active && !alert   && 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {isAmber  && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />}
              {isRed    && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />}
              {isIndigo && <span className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />}
              {isGreen  && <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />}
            </Link>
          )
        })}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-gray-800">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm
                     text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Cerrar sesión
        </button>
      </div>

    </aside>
  )
}
