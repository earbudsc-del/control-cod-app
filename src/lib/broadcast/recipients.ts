// Sprint C.2 — búsqueda y paginación de destinatarios del asistente. Puro.

import type { LaunchRecipient } from './launch'

export const RECIPIENTS_PAGE_SIZE_MAX = 100

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export interface RecipientsPage {
  items:          LaunchRecipient[]
  page:           number
  page_size:      number
  filtered_total: number
  pages:          number
}

/** Búsqueda por número de pedido, nombre o teléfono (texto plano, en memoria). */
export function paginateRecipients(all: LaunchRecipient[], q: { page?: unknown; page_size?: unknown; search?: unknown }): RecipientsPage {
  const pageSize = Math.min(Math.max(1, Math.floor(Number(q.page_size) || 25)), RECIPIENTS_PAGE_SIZE_MAX)
  const raw = typeof q.search === 'string' ? q.search.trim().slice(0, 80) : ''
  const needle = norm(raw)
  const digits = raw.replace(/\D/g, '')
  const filtered = needle
    ? all.filter(r => norm(`${r.order_number ?? ''} ${r.customer_name ?? ''}`).includes(needle)
        || (digits.length >= 3 && r.phone_normalized.includes(digits)))
    : all
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, Math.floor(Number(q.page) || 1)), pages)
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), page, page_size: pageSize, filtered_total: filtered.length, pages }
}
