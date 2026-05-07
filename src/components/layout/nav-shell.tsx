'use client'

import { useState } from 'react'
import { Menu, Truck } from 'lucide-react'
import { Sidebar } from './sidebar'
import type { UserRole } from '@/types'

interface NavShellProps {
  role: UserRole | string
}

export function NavShell({ role }: NavShellProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* Topbar móvil — solo visible en < md */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 z-30
                         bg-gray-900 border-b border-gray-800
                         flex items-center gap-3 px-4">
        <button
          onClick={() => setOpen(true)}
          className="p-2 -ml-2 text-gray-400 hover:text-white rounded-lg transition-colors"
          aria-label="Abrir menú"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 bg-blue-600 rounded-lg shrink-0">
            <Truck className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-white font-semibold text-sm">Control COD</span>
        </div>
      </header>

      {/* Overlay oscuro — solo en móvil cuando está abierto */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar con soporte de drawer en móvil */}
      <Sidebar role={role} isOpen={open} onClose={() => setOpen(false)} />
    </>
  )
}
