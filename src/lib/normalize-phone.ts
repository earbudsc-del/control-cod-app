export function normalizePhoneRD(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return digits
  if (digits.length > 11) return `1${digits.slice(-10)}`
  return digits
}
