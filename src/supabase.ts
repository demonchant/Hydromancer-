import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
export const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? ''

export const backendConfigured = Boolean(url && key)
const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController()
  const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const abortRequest = () => controller.abort()
  requestSignal?.addEventListener('abort', abortRequest, { once: true })
  const timeout = window.setTimeout(abortRequest, 20_000)
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    window.clearTimeout(timeout)
    requestSignal?.removeEventListener('abort', abortRequest)
  })
}
export const supabase = backendConfigured ? createClient(url!, key!, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  global: { fetch: fetchWithTimeout },
}) : null

export type MonitorRow = {
  id: string
  user_id: string
  address: string
  threshold_percent: number
  enabled: boolean
  last_gap_percent: number | null
  last_coin: string | null
  last_checked_at: string | null
  last_error: string | null
  in_warning: boolean
}

export type StoredAlert = {
  id: number
  monitor_id: string
  user_id: string
  kind: 'warning' | 'recovery'
  message: string
  coin: string | null
  gap_percent: number | null
  created_at: string
}
