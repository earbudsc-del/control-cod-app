import { AlertTriangle, MapPinOff, Navigation, HelpCircle, Building2 } from 'lucide-react'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'

interface AlertBadgesProps {
  duplicateAlert?:  boolean | null
  customerAddress?: string | null
  city?:            string | null
  province?:        string | null
  className?:       string
}

export function AlertBadges({
  duplicateAlert,
  customerAddress,
  city,
  province,
  className = '',
}: AlertBadgesProps) {
  const coverage    = checkCoverage(customerAddress, city, province)
  const showDup     = !!duplicateAlert
  const showOoc     = coverage.isOutOfCoverage
  const showSpec    = !coverage.isOutOfCoverage && coverage.isSpecialDestination
  const showUnknown = !coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone
  const showSD      = isSantoDomingoOrder(city, province, customerAddress)

  if (!showDup && !showOoc && !showSpec && !showUnknown && !showSD) return null

  return (
    <div className={`flex flex-wrap gap-1 mt-0.5 ${className}`}>
      {showDup && (
        <span className="inline-flex items-center gap-0.5 bg-amber-50 text-amber-700
                         border border-amber-200 text-[10px] font-bold px-1.5 py-0.5
                         rounded-full whitespace-nowrap">
          <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
          Posible duplicado
        </span>
      )}
      {showOoc && (
        <span
          className="inline-flex items-center gap-0.5 bg-red-50 text-red-700
                     border border-red-200 text-[10px] font-bold px-1.5 py-0.5
                     rounded-full whitespace-nowrap"
          title={`Zona detectada: ${coverage.matchedZones.join(', ')}`}
        >
          <MapPinOff className="w-2.5 h-2.5 shrink-0" />
          Fuera de cobertura
        </span>
      )}
      {showSpec && (
        <span
          className="inline-flex items-center gap-0.5 bg-blue-50 text-blue-700
                     border border-blue-200 text-[10px] font-bold px-1.5 py-0.5
                     rounded-full whitespace-nowrap"
          title={`Destino especial: ${coverage.matchedZones.join(', ')}`}
        >
          <Navigation className="w-2.5 h-2.5 shrink-0" />
          Destino especial
        </span>
      )}
      {showUnknown && (
        <span
          className="inline-flex items-center gap-0.5 bg-yellow-50 text-yellow-700
                     border border-yellow-200 text-[10px] font-bold px-1.5 py-0.5
                     rounded-full whitespace-nowrap"
          title="Ciudad no registrada en la matriz de cobertura"
        >
          <HelpCircle className="w-2.5 h-2.5 shrink-0" />
          Zona desconocida
        </span>
      )}
      {showSD && (
        <span
          className="inline-flex items-center gap-0.5 bg-purple-50 text-purple-700
                     border border-purple-200 text-[10px] font-bold px-1.5 py-0.5
                     rounded-full whitespace-nowrap"
          title="Pedido Santo Domingo — usar transporte local, no EFI"
        >
          <Building2 className="w-2.5 h-2.5 shrink-0" />
          SD / Transporte local
        </span>
      )}
    </div>
  )
}
