export function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? `${Math.round(value * 1000) / 10}%` : '—'
}
export function number(value, locale) {
  return Number.isFinite(value) ? new Intl.NumberFormat(locale).format(Math.round(value)) : '—'
}
export function resetTime(value, locale) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '—'
}
export function selectedGroup(groups, model = '') {
  if (/gemini/i.test(model)) return groups.find(group => /gemini/i.test(group.name))
  if (/claude|gpt/i.test(model)) return groups.find(group => /claude|gpt/i.test(group.name))
  return groups[0]
}
export const shortGroup = group => /gemini/i.test(group?.name ?? '') ? 'Gemini' : /claude|gpt/i.test(group?.name ?? '') ? 'Claude/GPT' : group?.name ?? 'AGY'
