import { Badge } from '@/components/ui/badge'
import { STATUS_LABELS, STATUS_COLORS, type NormalizedStatus } from '@/types'

export function StatusBadge({ status }: { status: NormalizedStatus }) {
  return (
    <Badge className={STATUS_COLORS[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
