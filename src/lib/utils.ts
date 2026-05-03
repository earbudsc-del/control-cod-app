import type { SlaStatus } from '@/types'

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function formatDate(date: string | null | undefined, showTime = false): string {
  if (!date) return '—'
  const d = new Date(date)
  if (isNaN(d.getTime())) return '—'
  const opts: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Santo_Domingo',
  }
  if (showTime) {
    opts.hour = '2-digit'
    opts.minute = '2-digit'
  }
  return d.toLocaleDateString('es-DO', opts)
}

// Fecha exacta con hora 12h en zona RD: "24/04/2026 3:47 PM"
export function formatEventDate(date: string | null | undefined): string {
  if (!date) return '—'
  const d = new Date(date)
  if (isNaN(d.getTime())) return '—'
  const datePart = d.toLocaleDateString('es-DO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Santo_Domingo',
  })
  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Santo_Domingo',
  })
  return `${datePart} ${timePart}`
}

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('es-DO', {
    style: 'currency',
    currency: 'DOP',
    minimumFractionDigits: 2,
  }).format(amount)
}

export function daysSince(date: string | null | undefined): string {
  if (!date) return '—'
  const d = new Date(date)
  if (isNaN(d.getTime())) return '—'
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'Hoy'
  if (days === 1) return 'Hace 1 día'
  return `Hace ${days} días`
}

export function timeAgo(date: string | null | undefined): string {
  if (!date) return '—'
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'ahora'
  if (mins < 60) return `hace ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `hace ${hours}h`
  return `hace ${Math.floor(hours / 24)}d`
}

export function getSlaStatus(
  slaDeadline: string | null | undefined,
  slaBreached: boolean,
): SlaStatus {
  if (!slaDeadline) return 'none'
  if (slaBreached) return 'breached'
  const remaining = new Date(slaDeadline).getTime() - Date.now()
  if (remaining <= 0) return 'breached'
  if (remaining < 2 * 60 * 60 * 1000) return 'warning'
  return 'ok'
}

export function formatHoursRemaining(slaDeadline: string | null | undefined): string {
  if (!slaDeadline) return ''
  const remaining = new Date(slaDeadline).getTime() - Date.now()
  if (remaining <= 0) return 'Vencido'
  const hours = Math.floor(remaining / (1000 * 60 * 60))
  const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
  if (hours === 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

export function truncate(text: string | null | undefined, max = 40): string {
  if (!text) return '—'
  return text.length > max ? text.slice(0, max) + '…' : text
}

// Normaliza número de teléfono dominicano para WhatsApp (wa.me/1809XXXXXXX)
export function phoneToWhatsApp(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  // Ya tiene código de país +1
  if (digits.length === 11 && digits.startsWith('1')) return digits
  // 10 dígitos con área RD (809, 829, 849)
  if (digits.length === 10 && /^8[02489]9/.test(digits)) return `1${digits}`
  // 7 dígitos: asumir 809
  if (digits.length === 7) return `1809${digits}`
  // Otro formato de 10 dígitos
  if (digits.length === 10) return `1${digits}`
  return null
}

export function whatsAppUrl(phone: string | null | undefined, message?: string): string | null {
  const formatted = phoneToWhatsApp(phone)
  if (!formatted) return null
  const base = `https://wa.me/${formatted}`
  return message ? `${base}?text=${encodeURIComponent(message)}` : base
}

export function callUrl(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (!digits) return null
  return `tel:+${digits.startsWith('1') ? digits : `1${digits}`}`
}
