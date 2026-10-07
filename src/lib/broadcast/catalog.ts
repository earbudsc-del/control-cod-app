// Sprint Broadcast B.2.2 — precios de catálogo conocidos (única fuente).
//
// Solo constantes comerciales verificadas contra producción (auditoría B.2):
//   - Oferta Personal 2×1: 2 LÜMA Teeth + 1 cepillo antibacterial de regalo
//     → RD$2,100 (3,511 pedidos).
//   - Envío prioritario: +RD$100 sobre el bundle (2,200 = 2,100 + 100).
// Ningún otro archivo de Broadcast debe contener montos literales.

export const PERSONAL_BUNDLE_PRICE = 2100
export const PRIORITY_SHIPPING_SURCHARGE = 100
