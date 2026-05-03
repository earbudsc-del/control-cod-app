import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Control COD',
  description: 'Sistema de control de pedidos COD',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
