import { createClient } from 'npm:@supabase/supabase-js@2'
import { nearestLiquidationDistance, type RiskPosition } from '../../../src/risk.ts'

type Monitor = {
  id: string
  user_id: string
  address: string
}
type Position = { position?: { coin?: string; szi?: string; liquidationPx?: string | null } }
type AccountState = { assetPositions?: Position[] }
type PerpMetaAndContexts = [
  { universe?: Array<{ name?: string }> },
  Array<{ markPx?: string | number }>,
]

const endpoint = 'https://api.hyperliquid.xyz/info'
const encoder = new TextEncoder()

function sameSecret(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`Hyperliquid request failed with status ${response.status}`)
  return response.json() as Promise<T>
}

function markPricesFromContexts(result: PerpMetaAndContexts): Record<string, number> {
  const [meta, contexts] = result
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts)) {
    throw new Error('Hyperliquid returned invalid mark price contexts.')
  }
  return Object.fromEntries(meta.universe.flatMap((asset, index) => {
    const mark = Number(contexts[index]?.markPx)
    return asset.name && Number.isFinite(mark) && mark > 0 ? [[asset.name, mark]] : []
  }))
}

function nearestGap(state: AccountState, markPrices: Record<string, number>) {
  if (!Array.isArray(state.assetPositions)) throw new Error('Hyperliquid returned an invalid position list.')
  const positions: RiskPosition[] = state.assetPositions.map((entry, index) => {
    const source = entry?.position
    const size = Number(source?.szi)
    const liquidation = source?.liquidationPx
    return {
      coin: typeof source?.coin === 'string' && source.coin ? source.coin : `Unknown position ${index + 1}`,
      size,
      liquidationPrice: liquidation === null || liquidation === undefined || liquidation === '' ? null : Number(liquidation),
    }
  })
  const assessment = nearestLiquidationDistance(positions, markPrices)
  return assessment.status === 'available' ? assessment.distance : null
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const cronSecret = Deno.env.get('MONITOR_CRON_SECRET') ?? ''
  const suppliedSecret = request.headers.get('x-monitor-secret') ?? ''
  if (cronSecret.length < 32 || !sameSecret(suppliedSecret, cronSecret)) return new Response('Unauthorized', { status: 401 })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return Response.json({ error: 'Server configuration is incomplete.' }, { status: 503 })
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: claimed, error: lockError } = await supabase.rpc('claim_monitor_job')
  if (lockError) return Response.json({ error: 'Could not acquire the monitor job lock.' }, { status: 503 })
  if (!claimed) return Response.json({ skipped: 'Another monitor run holds the lease.' }, { status: 200 })

  let checked = 0
  let failed = 0
  let alertsCreated = 0
  try {
    const { data: monitors, error: monitorError } = await supabase.from('monitors')
      .select('id,user_id,address')
      .eq('enabled', true)
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(500)
    if (monitorError) throw new Error('Monitor records could not be loaded.')

    if (monitors?.length) {
      let marks: Record<string, number>
      try { marks = markPricesFromContexts(await info<PerpMetaAndContexts>({ type: 'metaAndAssetCtxs' })) }
      catch { throw new Error('Live mark prices could not be read. No account risk states were changed.') }
      if (!Object.keys(marks).length) throw new Error('No valid live mark prices were returned. No account risk states were changed.')

      const queue = [...monitors as Monitor[]]
      const runWorker = async () => {
        while (queue.length) {
          const monitor = queue.shift()
          if (!monitor) return
          const checkedAt = new Date().toISOString()
          try {
            const state = await info<AccountState>({ type: 'clearinghouseState', user: monitor.address })
            const nearest = nearestGap(state, marks)
            const { data: transition, error: transitionError } = await supabase.rpc('record_monitor_result', {
              p_monitor_id: monitor.id,
              p_gap_percent: nearest?.gap ?? null,
              p_coin: nearest?.coin ?? null,
              p_checked_at: checkedAt,
            })
            if (transitionError) throw new Error('Account check could not be recorded.')
            if (transition?.kind === 'warning') alertsCreated += 1
            checked += 1
          } catch (error) {
            failed += 1
            const message = error instanceof Error ? error.message.slice(0, 200) : 'Account check failed.'
            await supabase.from('monitors').update({ last_checked_at: checkedAt, last_error: message }).eq('id', monitor.id)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(16, queue.length) }, () => runWorker()))
    }

    return Response.json({ checked, failed, alertsCreated, completedAt: new Date().toISOString() })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Monitor run failed.' }, { status: 503 })
  } finally {
    await supabase.rpc('release_monitor_job')
  }
})
