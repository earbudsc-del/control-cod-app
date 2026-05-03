import { cn } from '@/lib/utils'
import { formatHoursRemaining } from '@/lib/utils'
import type { SlaStatus } from '@/types'

const SLA_STYLES: Record<SlaStatus, string> = {
  ok:       'bg-green-100 text-green-700',
  warning:  'bg-amber-100 text-amber-700',
  breached: 'bg-red-100 text-red-700 font-semibold',
  none:     'bg-gray-100 text-gray-400',
}

const SLA_LABELS: Record<SlaStatus, string> = {
  ok:       'En tiempo',
  warning:  'Por vencer',
  breached: 'Vencido',
  none:     'Sin SLA',
}

interface SlaBadgeProps {
  status: SlaStatus
  deadline?: string | null
}

export function SlaBadge({ status, deadline }: SlaBadgeProps) {
  const remaining = status !== 'none' && status !== 'breached' && deadline
    ? formatHoursRemaining(deadline)
    : null

  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs',
      SLA_STYLES[status],
    )}>
      {SLA_LABELS[status]}
      {remaining && <span className="opacity-75">· {remaining}</span>}
    </span>
  )
}
