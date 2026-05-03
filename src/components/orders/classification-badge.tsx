import { Badge } from '@/components/ui/badge'
import { CLASSIFICATION_LABELS, CLASSIFICATION_COLORS, type Classification } from '@/types'

export function ClassificationBadge({ classification }: { classification: Classification | null }) {
  if (!classification) return <span className="text-gray-400 text-xs">—</span>
  return (
    <Badge className={CLASSIFICATION_COLORS[classification]}>
      {CLASSIFICATION_LABELS[classification]}
    </Badge>
  )
}
