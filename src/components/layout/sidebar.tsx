'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard, Package, Upload, BarChart2,
  Settings, LogOut, Truck, Bike, AlertCircle, ClipboardList,
  ListTodo, TrendingUp, Box, CheckCircle2, X, ShoppingCart, Brain,
  RotateCcw, Link2, MapPin,
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
    { href: '/dashboard',              label: 'Dashboard',            icon: LayoutDashboard, alert: null     },
    { href: '/supervisor-ia',          label: 'Supervisor IA',        icon: Brain,           alert: null     },
    { href: '/reparto',                label: 'En Reparto',           icon: Bike,            alert: 'amber'  },
    { href: '/novedad',                label: 'Novedades',            icon: AlertCircle,     alert: 'red'    },
    { href: '/transito',               label: 'Tránsito',             icon: Box,             alert: null     },
    { href: '/devoluciones',           label: 'Devoluciones',         icon: RotateCcw,       alert: 'red'    },
    { href: '/confirmacion',           label: 'Confirmación',         icon: ClipboardList,   alert: 'indigo' },
    { href: '/confirmados',            label: 'Confirmados',          icon: CheckCircle2,    alert: 'green'  },
    { href: '/despachados',            label: 'Despachados',          icon: Truck,           alert: null     },
    { href: '/carritos-abandonados',   label: 'Carritos abandonados', icon: ShoppingCart,    alert: null     },
    { href: '/orders',                 label: 'Pedidos',              icon: Package,         alert: null     },
    { href: '/imports',                label: 'Importar',             icon: Upload,          alert: null     },
    { href: '/efi-import',             label: 'Importar guías EFI',   icon: Link2,           alert: null     },
    { href: '/performance',            label: 'Rendimiento',          icon: BarChart2,       alert: null     },
    { href: '/settings',               label: 'Configuración',        icon: Settings,        alert: null     },
  ],

  ia_supervisor: [
    { href: '/supervisor-ia',  label: 'Supervisor IA', icon: Brain,           alert: null },
    { href: '/dashboard',      label: 'Dashboard',     icon: LayoutDashboard, alert: null },
    { href: '/devoluciones',   label: 'Devoluciones',  icon: RotateCcw,       alert: 'red' },
    { href: '/my-tasks',       label: 'Mis tareas',    icon: ListTodo,        alert: null },
    { href: '/transito',       label: 'Tránsito',      icon: Box,             alert: null },
    { href: '/orders',         label: 'Pedidos',       icon: Package,         alert: null },
  ],

  confirmation_agent: [
    { href: '/mi-rendimiento',           label: 'Mi rendimiento',       icon: TrendingUp,    alert: null     },
    { href: '/confirmacion',             label: 'Confirmaciones',       icon: ClipboardList, alert: 'indigo' },
    { href: '/carritos-abandonados',     label: 'Carritos abandonados', icon: ShoppingCart,  alert: null     },
  ],

  novelty_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp,  alert: null     },
    { href: '/novedad',        label: 'Novedades',      icon: AlertCircle, alert: 'red'    },
    { href: '/reparto',        label: 'En Reparto',     icon: Bike,        alert: 'amber'  },
    { href: '/transito',       label: 'Tránsito',       icon: Box,         alert: null     },
    { href: '/devoluciones',   label: 'Devoluciones',   icon: RotateCcw,   alert: 'red'    },
  ],

  delivery_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp, alert: null    },
    { href: '/reparto',        label: 'En Reparto',     icon: Bike,       alert: 'amber' },
    { href: '/transito',       label: 'Tránsito',       icon: Box,        alert: null    },
  ],

  santo_domingo_delivery_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento',  icon: TrendingUp, alert: null    },
    { href: '/sd-delivery',    label: 'Entregas SD',     icon: MapPin,     alert: 'amber' },
  ],

  dispatch_agent: [
    { href: '/mi-rendimiento', label: 'Mi rendimiento', icon: TrendingUp,  alert: null    },
    { href: '/confirmados',    label: 'Confirmados',    icon: CheckCircle2, alert: 'green' },
  ],

  agent: [
    { href: '/my-tasks',     label: 'Mis tareas',     icon: ListTodo,        alert: null     },
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
  ],

  viewer: [
    { href: '/orders',       label: 'Pedidos',        icon: Package,         alert: null     },
  ],
}

// ─── Componente ─────────────────────────────────────────────────────────────

interface SidebarProps {
  role:     UserRole | string
  isOpen?:  boolean
  onClose?: () => void
}

export function Sidebar({ role, isOpen = false, onClose }: SidebarProps) {
  const pathname  = usePathname()
  const didMount  = useRef(false)

  // Auto-cierra el drawer en móvil cuando el usuario navega
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return }
    onClose?.()
  // pathname cambia al navegar — ignorar onClose en deps para evitar loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  const nav = NAV_BY_ROLE[role] ?? NAV_BY_ROLE['agent']

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <aside className={cn(
      'fixed inset-y-0 left-0 w-56 bg-gray-900 flex flex-col z-50',
      'transition-transform duration-300 ease-in-out',
      // Móvil: oculto por defecto, visible cuando isOpen
      // Desktop (md+): siempre visible independientemente de isOpen
      isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
    )}>

      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-5 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 bg-blue-600 rounded-lg shrink-0">
            <Truck className="w-4 h-4 text-white" />
          </div>
          <span className="text-white font-semibold text-sm">Control COD</span>
        </div>
        {/* Botón X — solo en móvil */}
        <button
          onClick={onClose}
          className="md:hidden p-1.5 text-gray-400 hover:text-white rounded-lg transition-colors"
          aria-label="Cerrar menú"
        >
          <X className="w-4 h-4" />
        </button>
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
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
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
