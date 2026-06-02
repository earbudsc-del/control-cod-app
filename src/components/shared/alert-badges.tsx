import { AlertTriangle, MapPinOff, Navigation, HelpCircle, Building2, CreditCard } from 'lucide-react'
import { checkCoverage, isSantoDomingoOrder, isTransferOrder } from '@/lib/alert-helpers'

interface AlertBadgesProps {
  duplicateAlert?:  boolean | null
  customerAddress?: string | null
  city?:            string | null
  province?:        string | null
  productSummary?:  string | null
  className?:       string
}

export function AlertBadges({
  duplicateAlert,
  customerAddress,
  city,
  province,
  productSummary,
  className = '',
}: AlertBadgesProps) {
  const coverage     = checkCoverage(customerAddress, city, province)
  const showDup      = !!duplicateAlert
  const showOoc      = coverage.isOutOfCoverage
  const showSpec     = !coverage.isOutOfCoverage && coverage.isSpecialDestination
  const showUnknown  = !coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone
  const showSD       = isSantoDomingoOrder(city, province, customerAddress)
  const showTransfer = isTransferOrder(productSummary)

  if (!showDup && !showOoc && !showSpec && !showUnknown && !showSD && !showTransfer) return null

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
          title="Zona no verificada — confirmar dirección antes de despachar"
        >
          <HelpCircle className="w-2.5 h-2.5 shrink-0" />
          Validar dirección
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
      {showTransfer && (
        <span
          className="inline-flex items-center gap-0.5 bg-violet-600 text-white
                     text-[10px] font-bold px-1.5 py-0.5
                     rounded-full whitespace-nowrap"
          title="Promoción LÜMA 3 uds — pagada por transferencia, NO es COD"
        >
          <CreditCard className="w-2.5 h-2.5 shrink-0" />
          TRANSFERENCIA · NO COD
        </span>
      )}
    </div>
  )
}
