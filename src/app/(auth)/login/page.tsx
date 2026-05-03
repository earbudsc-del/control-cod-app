'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    console.log('submit login', { email })
    setError(null)
    setLoading(true)

    const supabase = createClient()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    console.log('signIn result', data?.user?.id ?? null, error?.message ?? null)

    if (error) {
      setError('Credenciales incorrectas. Verifica tu correo y contraseña.')
      setLoading(false)
      return
    }

    console.log('redirect dashboard')
    window.location.href = '/dashboard'
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo / marca */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-600 rounded-xl mb-4">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0v10l-8 4m0-10L4 7m8 4v10" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Control COD</h1>
          <p className="text-gray-400 text-sm mt-1">Sistema de pedidos</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Correo electrónico
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white
                         placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500
                         focus:border-transparent"
              placeholder="usuario@empresa.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Contraseña
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white
                         placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500
                         focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50
                       disabled:cursor-not-allowed text-white font-medium rounded-lg
                       transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  )
}
