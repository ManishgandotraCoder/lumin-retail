// Local PII masking used for logs and the audit trail.
// Altrum handles masking of live traffic; this keeps our own logs clean too.

const patterns: Array<[RegExp, string]> = [
  // (?<![\w-]) / (?![\w-]) stop these matching inside our own IDs such as LUM-ORD-20261101-0001
  [/(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g, '[CARD]'], // card-like numbers (13-19 digits)
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]'],
  [/(?:\+91[ -]?)?(?<![\w-])[6-9]\d{4}[ -]?\d{5}(?![\w-])/g, '[PHONE]'], // Indian mobile numbers
  [/(?<![\w-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\w-])/g, '[ID_NUMBER]'], // Aadhaar-like 12 digits
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]'],
  [/\b(?:cvv|otp|pin|password)\s*[:=]?\s*\S+/gi, '[SECRET]'],
]

export function maskPII(text: string): string {
  return patterns.reduce((acc, [re, label]) => acc.replace(re, label), text)
}

export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskPII(value) as T
  if (Array.isArray(value)) return value.map(maskDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T
  }
  return value
}
