import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccountSnapshot, connectMids, fetchAccount, fetchMids, validAddress } from './hyperliquid'
import { nearestLiquidationDistance } from './risk'
import { backendConfigured, MonitorRow, StoredAlert, supabase, turnstileSiteKey } from './supabase'
import type { User } from '@supabase/supabase-js'

type AlertEvent = { id: string; time: number; kind: 'warning' | 'recovery'; message: string }
type Tab = 'overview' | 'activity' | 'settings'
type Connection = 'connecting' | 'live' | 'reconnecting'
const ADDRESS_KEY = 'hydromancer.address'
const THRESHOLD_KEY = 'hydromancer.threshold'
const ALERTS_KEY = 'hydromancer.alerts'

function readAlerts(): AlertEvent[] {
  try { return JSON.parse(localStorage.getItem(ALERTS_KEY) ?? '[]') as AlertEvent[] } catch { return [] }
}
function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}
function shortAddress(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}` }
function Icon({ name }: { name: 'water' | 'pulse' | 'shield' | 'activity' | 'settings' | 'arrow' | 'bell' | 'external' }) {
  const paths: Record<typeof name, React.ReactNode> = {
    water: <><path d="M12 2.8S5.2 10.1 5.2 15.8a6.8 6.8 0 0 0 13.6 0C18.8 10.1 12 2.8 12 2.8Z"/><path d="M9 16.2a3.1 3.1 0 0 0 3.1 3.1"/></>,
    pulse: <><path d="M3 12h4l2.1-6 4.2 12 2.1-6H21"/></>,
    shield: <><path d="M12 3 19 6v5c0 4.7-2.9 8-7 10-4.1-2-7-5.3-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/></>,
    activity: <><path d="M4 19V5m0 14h16"/><path d="m7 15 3-4 3 2 5-7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-1.2 2.1-1.5-.5a7.7 7.7 0 0 1-1.5.9l-.3 1.6h-2.4l-.3-1.6a7.7 7.7 0 0 1-1.5-.9l-1.5.5-1.2-2.1 1.2-1a7.6 7.6 0 0 1 0-1.8l-1.2-1 1.2-2.1 1.5.5a7.7 7.7 0 0 1 1.5-.9l.3-1.6h2.4l.3 1.6a7.7 7.7 0 0 1 1.5.9l1.5-.5 1.2 2.1-1.2 1a7.6 7.6 0 0 1-.1 1.7Z"/></>,
    arrow: <><path d="M4 12h15"/><path d="m13 6 6 6-6 6"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    external: <><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function App() {
  const [screen, setScreen] = useState<'landing' | 'monitor'>('landing')
  const [address, setAddress] = useState(() => backendConfigured ? '' : localStorage.getItem(ADDRESS_KEY) ?? '')
  const [input, setInput] = useState(() => backendConfigured ? '' : localStorage.getItem(ADDRESS_KEY) ?? '')
  const [account, setAccount] = useState<AccountSnapshot | null>(null)
  const [mids, setMids] = useState<Record<string, number>>({})
  const [connection, setConnection] = useState<Connection>('connecting')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [formError, setFormError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [threshold, setThreshold] = useState(() => backendConfigured ? 8 : Number(localStorage.getItem(THRESHOLD_KEY) ?? 8))
  const [alerts, setAlerts] = useState<AlertEvent[]>(() => backendConfigured ? [] : readAlerts())
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(backendConfigured)
  const [authMessage, setAuthMessage] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaReady, setCaptchaReady] = useState(false)
  const [serverMonitor, setServerMonitor] = useState<MonitorRow | null>(null)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [monitorLoading, setMonitorLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => 'Notification' in window ? Notification.permission : 'unsupported')
  const [riskSamples, setRiskSamples] = useState<number[]>([])
  const [clock, setClock] = useState(Date.now())
  const priorRisk = useRef<number | null>(null)
  const sessionLoaded = useRef('')
  const serverEventIds = useRef<Set<string>>(new Set())
  const requestInFlight = useRef(false)
  const activeAddress = useRef(address)
  const requestController = useRef<AbortController | null>(null)
  const hostedMode = Boolean(backendConfigured && authUser)

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return }
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) { setAuthUser(data.session?.user ?? null); setAuthLoading(false) }
    }).catch(() => { if (active) { setAuthMessage('Private monitor session could not be read. Refresh and try again.'); setAuthLoading(false) } })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null)
      setAuthLoading(false)
      if (!session?.user) {
        setServerMonitor(null)
        setAlerts([])
        setAddress('')
        setInput('')
        setAccount(null)
      }
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!turnstileSiteKey || screen !== 'monitor' || authLoading || authUser) return
    let widget: string | null = null
    if (!window.turnstile && !document.querySelector('[data-hydromancer-turnstile]')) {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.dataset.hydromancerTurnstile = 'true'
      document.head.appendChild(script)
    }
    const deadline = Date.now() + 15000
    const timer = window.setInterval(() => {
      const container = document.getElementById('turnstile-widget')
      if (!container) return
      if (!window.turnstile) {
        if (Date.now() > deadline) {
          window.clearInterval(timer)
          setAuthMessage('Security check could not load. Check the site key and network, then refresh.')
        }
        return
      }
      window.clearInterval(timer)
      widget = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        callback: (token) => { setCaptchaToken(token); setCaptchaReady(true); setAuthMessage('') },
        'expired-callback': () => { setCaptchaToken(''); setCaptchaReady(false) },
        'error-callback': () => { setCaptchaToken(''); setCaptchaReady(false); setAuthMessage('Security check could not load. Refresh the page and try again.') },
      })
    }, 100)
    return () => {
      window.clearInterval(timer)
      if (widget) window.turnstile?.remove(widget)
      setCaptchaToken('')
      setCaptchaReady(false)
    }
  }, [screen, authLoading, authUser])

  useEffect(() => {
    const client = supabase
    if (!client || !authUser) return
    let active = true
    let loading = false
    if (sessionLoaded.current && sessionLoaded.current !== authUser.id) serverEventIds.current.clear()
    const load = async () => {
      if (loading) return
      loading = true
      const firstLoad = sessionLoaded.current !== authUser.id
      if (firstLoad) setMonitorLoading(true)
      try {
        const [monitorResult, eventResult] = await Promise.all([
          client.from('monitors').select('*').maybeSingle(),
          client.from('monitor_events').select('*').order('created_at', { ascending: false }).limit(100),
        ])
        if (!active) return
        if (monitorResult.error) setAuthMessage('Saved monitor could not be loaded. Check the database setup and try again.')
        else {
          setAuthMessage('')
          const monitor = monitorResult.data as MonitorRow | null
          setServerMonitor(monitor)
          if (monitor) {
            setAddress(monitor.address)
            setInput(monitor.address)
            if (!settingsDirty) setThreshold(monitor.threshold_percent)
          } else {
            setAddress('')
            setInput('')
          }
        }
        if (eventResult.error) setAuthMessage('Alert history could not be loaded. Check the database setup and try again.')
        else {
          const rows = (eventResult.data ?? []) as StoredAlert[]
          const next = rows.map((event) => ({ id: String(event.id), kind: event.kind, message: event.message, time: new Date(event.created_at).getTime() }))
          if (sessionLoaded.current === authUser.id && next.some((event) => !serverEventIds.current.has(event.id))) setNotice('A new threshold event was saved to your private activity.')
          serverEventIds.current = new Set(next.map((event) => event.id))
          setAlerts(next)
        }
      } catch {
        if (active) setAuthMessage('Your private session could not reach Supabase. Check your connection and retry.')
      } finally {
        loading = false
        if (active && firstLoad) {
          sessionLoaded.current = authUser.id
          setMonitorLoading(false)
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [authUser, settingsDirty])

  const distance = useMemo(() => {
    if (!account) return null
    return nearestLiquidationDistance(account.positions, mids)
  }, [account, mids])

  const addAlert = useCallback((kind: AlertEvent['kind'], message: string) => {
    if (hostedMode) return
    const next = [{ id: crypto.randomUUID(), kind, message, time: Date.now() }, ...readAlerts()].slice(0, 80)
    localStorage.setItem(ALERTS_KEY, JSON.stringify(next))
    setAlerts(next)
    setNotice(kind === 'warning' ? 'Risk threshold reached' : 'Account risk returned below your threshold')
    if (notificationPermission === 'granted') new Notification(kind === 'warning' ? 'Hydromancer risk alert' : 'Hydromancer recovery', { body: message })
  }, [notificationPermission, hostedMode])

  const refreshAccount = useCallback(async (selected = address) => {
    if (!selected || requestInFlight.current) return
    requestInFlight.current = true
    setSyncing(true)
    const controller = new AbortController()
    requestController.current = controller
    try {
      const snapshot = await fetchAccount(selected, controller.signal)
      if (activeAddress.current !== selected) return
      setAccount(snapshot)
      setSyncError('')
    } catch (error) {
      if (controller.signal.aborted) return
      if (activeAddress.current !== selected) return
      setSyncError(error instanceof Error ? error.message : 'Account data could not be read.')
    } finally {
      if (requestController.current === controller) {
        if (activeAddress.current === selected) setSyncing(false)
        requestInFlight.current = false
        requestController.current = null
      }
    }
  }, [address])

  useEffect(() => {
    const stop = connectMids(setMids, setConnection)
    const controller = new AbortController()
    fetchMids(controller.signal).then(setMids).catch(() => undefined)
    return () => { stop(); controller.abort() }
  }, [])

  useEffect(() => {
    if (!address) { activeAddress.current = ''; setAccount(null); return }
    activeAddress.current = address
    requestController.current?.abort()
    requestInFlight.current = false
    setAccount(null)
    setSyncError('')
    void refreshAccount(address)
    const timer = window.setInterval(() => void refreshAccount(address), 15000)
    return () => { window.clearInterval(timer); requestController.current?.abort() }
  }, [address, refreshAccount])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!hostedMode) localStorage.setItem(THRESHOLD_KEY, String(threshold))
  }, [threshold, hostedMode])

  useEffect(() => {
    if (hostedMode || !distance || syncError || !account || Date.now() - account.receivedAt > 30000) return
    const prior = priorRisk.current
    if (prior === null && distance.gap <= threshold) {
      addAlert('warning', `${distance.coin} is ${distance.gap.toFixed(2)} percent from its reported liquidation price.`)
    } else if (prior !== null && prior > threshold && distance.gap <= threshold) {
      addAlert('warning', `${distance.coin} moved within ${distance.gap.toFixed(2)} percent of its reported liquidation price.`)
    } else if (prior !== null && prior <= threshold && distance.gap > threshold) {
      addAlert('recovery', `The nearest reported liquidation price is now ${distance.gap.toFixed(2)} percent away.`)
    }
    priorRisk.current = distance.gap
    setRiskSamples((samples) => [...samples.slice(-47), distance.gap])
  }, [distance, threshold, addAlert, syncError, account, hostedMode])

  async function startPrivateSession() {
    if (!supabase) { setAuthMessage('Hosted monitor settings are missing. The local public monitor remains available.'); return }
    if (turnstileSiteKey && !captchaToken) { setAuthMessage('Complete the security check before continuing.'); return }
    setAuthLoading(true)
    setAuthMessage('')
    try {
      const { data, error } = await supabase.auth.signInAnonymously({ options: captchaToken ? { captchaToken } : undefined })
      if (error) throw error
      setAuthUser(data.user)
      setNotice('Private monitor session ready. Your saved monitor is available on this browser.')
    } catch (error) {
      const authError = error && typeof error === 'object' ? error as { code?: string; message?: string; name?: string } : {}
      const errorCode = `${authError.code ?? ''} ${authError.name ?? ''} ${authError.message ?? ''}`.toLowerCase()
      const reference = (authError.code ?? authError.name ?? 'unknown').replace(/[-_]/g, ' ').slice(0, 60)
      const detail = (authError.message ?? '').replace(/[\r\n]+/g, ' ').replace(/[-_]/g, ' ').slice(0, 140)
      if (errorCode.includes('timeout') || errorCode.includes('abort')) {
        setAuthMessage(`Supabase did not respond within 20 seconds. Check the project URL and network connection, then try again. Supabase says: ${detail || reference}.`)
      } else if (errorCode.includes('captcha') || errorCode.includes('turnstile')) {
        setAuthMessage(`The security check was rejected. Confirm the site key and Supabase CAPTCHA secret are from the same Turnstile widget, and that this domain is allowed. Supabase says: ${detail || reference}.`)
      } else if (errorCode.includes('anonymous') && (errorCode.includes('disabled') || errorCode.includes('provider'))) {
        setAuthMessage(`Anonymous sign ins are disabled in Supabase. Enable them in the Authentication provider settings. Supabase says: ${detail || reference}.`)
      } else if (errorCode.includes('api key') || errorCode.includes('apikey')) {
        setAuthMessage(`Supabase rejected the app key. Check that the project URL and public key belong to the same project. Supabase says: ${detail || reference}.`)
      } else if (errorCode.includes('rate limit') || errorCode.includes('too many')) {
        setAuthMessage(`There have been too many attempts. Wait a few minutes, refresh the security check, and try again. Supabase says: ${detail || reference}.`)
      } else {
        setAuthMessage(`The private session could not be created. Check Supabase anonymous access and CAPTCHA settings. Supabase says: ${detail || reference}.`)
      }
      if (turnstileSiteKey) {
        setCaptchaToken('')
        setCaptchaReady(false)
        window.turnstile?.reset()
      }
    }
    setAuthLoading(false)
  }

  async function submitAddress(event: FormEvent) {
    event.preventDefault()
    const normalized = input.trim()
    if (!validAddress(normalized)) {
      setFormError('Enter a valid public Hyperliquid account address.')
      return
    }
    setFormError('')
    if (hostedMode) {
      if (!supabase || !authUser) { setFormError('Sign in before saving a monitor.'); return }
      setMonitorLoading(true)
      const { data, error } = await supabase.rpc('save_my_monitor', {
        p_address: normalized,
        p_threshold_percent: threshold,
      })
      setMonitorLoading(false)
      if (error) { setFormError('The monitor could not be saved. Check the database setup and try again.'); return }
      setServerMonitor(data as MonitorRow)
      localStorage.removeItem(ADDRESS_KEY)
      setAddress(normalized)
      setInput(normalized)
      setSettingsDirty(false)
      setNotice('Monitor saved. Server checks and account alert history are now available.')
      return
    }
    localStorage.setItem(ADDRESS_KEY, normalized)
    setInput(normalized)
    setAddress(normalized)
    setNotice('Account address saved. Reading live Hyperliquid data.')
  }

  async function disconnect() {
    activeAddress.current = ''
    requestController.current?.abort()
    if (hostedMode && supabase && authUser) {
      setMonitorLoading(true)
      const { error } = await supabase.from('monitors').delete().eq('user_id', authUser.id)
      setMonitorLoading(false)
      if (error) { setNotice('Monitor could not be removed. Try again.'); return }
      setServerMonitor(null)
      setNotice('Monitor removed. Alert history remains available.')
    }
    localStorage.removeItem(ADDRESS_KEY)
    setAddress('')
    setInput('')
    setAccount(null)
    priorRisk.current = null
    setRiskSamples([])
    if (!hostedMode) setNotice('Account address removed from this browser.')
  }

  async function saveSettings() {
    if (hostedMode && supabase && authUser && address) {
      setMonitorLoading(true)
      const { data, error } = await supabase.rpc('save_my_monitor', {
        p_address: address,
        p_threshold_percent: threshold,
      })
      setMonitorLoading(false)
      if (error) { setNotice('Settings could not be saved. Try again.'); return }
      setServerMonitor(data as MonitorRow)
      setSettingsDirty(false)
      setNotice('Monitor settings saved to your account.')
    } else {
      setSettingsDirty(false)
      setNotice('Monitor settings saved in this browser.')
    }
  }

  async function clearActivity() {
    if (hostedMode && supabase && authUser) {
      const { error } = await supabase.from('monitor_events').delete().eq('user_id', authUser.id)
      if (error) { setNotice('Alert history could not be cleared. Try again.'); return }
      setAlerts([])
      serverEventIds.current.clear()
      setNotice('Alert history cleared from your account.')
      return
    }
    localStorage.removeItem(ALERTS_KEY)
    setAlerts([])
    setNotice('Alert history cleared from this browser.')
  }

  async function enableNotifications() {
    if (!('Notification' in window)) { setNotificationPermission('unsupported'); return }
    const result = await Notification.requestPermission()
    setNotificationPermission(result)
    setNotice(result === 'granted' ? 'Browser alerts are enabled.' : 'Browser alerts were not enabled.')
  }

  const live = connection === 'live'
  const accountReady = Boolean(account && !syncError)
  const serverCheckAge = serverMonitor?.last_checked_at ? Math.max(0, Math.floor((clock - new Date(serverMonitor.last_checked_at).getTime()) / 1000)) : null
  const serverHealthy = Boolean(hostedMode && serverCheckAge !== null && serverCheckAge < 120 && !serverMonitor?.last_error)
  const riskBand = !distance ? 'Not available' : distance.gap <= threshold ? 'Near threshold' : distance.gap <= threshold * 2 ? 'Watch' : 'Clear'
  const dataAge = account ? Math.max(0, Math.floor((clock - account.receivedAt) / 1000)) : null

  if (screen === 'landing') return <Landing address={address} onEnter={() => setScreen('monitor')} />

  return <div className="app-shell">
    <aside className="rail">
      <button className="brand" onClick={() => setScreen('landing')} aria-label="Hydromancer home"><span className="brand-mark"><Icon name="water" /></span><span>HYDROMANCER</span></button>
      <div className="rail-rule" />
      <nav aria-label="Main navigation" className="rail-nav">
        <button className={tab === 'overview' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('overview')}><Icon name="pulse"/><span>Overview</span></button>
        <button className={tab === 'activity' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('activity')}><Icon name="activity"/><span>Activity</span></button>
        <button className={tab === 'settings' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('settings')}><Icon name="settings"/><span>Settings</span></button>
      </nav>
      <div className="rail-bottom">
        <span className="rail-label">NETWORK</span>
        <span className="network-pill"><i className={live ? 'dot good' : 'dot warn'} />Hyperliquid mainnet</span>
        <span className="rail-foot">{serverHealthy ? 'Server checks active' : hostedMode ? 'Server check awaiting setup' : 'Browser checks only'}</span>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <button className="mobile-brand" onClick={() => setScreen('landing')}><span className="brand-mark"><Icon name="water" /></span>HYDROMANCER</button>
        <div className="topbar-spacer" />
        <div className="connection"><i className={live ? 'dot good' : 'dot warn'} /><span>{live ? 'Market feed live' : connection === 'connecting' ? 'Connecting to market' : 'Market feed reconnecting'}</span></div>
        {hostedMode && <span className="private-session"><i className="dot good"/>Private session</span>}
        {address && <button className="address-chip" onClick={() => void disconnect()} title="Remove the saved account address">{shortAddress(address)} <span aria-hidden="true">×</span></button>}
      </header>

      <div className="page-content">
        <section className="page-heading">
          <div><p className="eyebrow">HYPERCORE ACCOUNT MONITOR</p><h1>{tab === 'overview' ? 'Risk overview' : tab === 'activity' ? 'Alert activity' : 'Monitor settings'}</h1><p className="subtitle">See account risk from live Hyperliquid data, with every signal tied to its source.</p></div>
          <div className="sync-state"><i className={accountReady ? 'dot good' : 'dot warn'} />{accountReady ? `Account data updated ${dataAge === 0 ? 'just now' : `${dataAge}s ago`}` : address ? 'Waiting for account data' : 'No account connected'}</div>
        </section>

        {notice && <div className="notice" role="status"><Icon name="shield"/><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
        {authUser && authMessage && <div className="error-banner" role="alert"><strong>Private session needs attention</strong><span>{authMessage}</span><button onClick={() => window.location.reload()}>Retry</button></div>}
        {tab === 'overview' && <>
          {backendConfigured && authLoading && <section className="loading-panel"><span className="loader"/><div><strong>Preparing your private session</strong><span>Connecting to Supabase authentication. This should take a few seconds.</span></div></section>}
          {backendConfigured && !authLoading && !authUser && <section className="signin-panel"><div className="connect-art sign-in-art" aria-hidden="true"><div className="orb orb-one"/><div className="art-ripple ripple-one"/><span className="art-drop"><Icon name="shield"/></span></div><div className="connect-copy"><p className="eyebrow">PRIVATE GUEST ACCESS</p><h2>Try the full monitor</h2><p>Start a private session to save your monitor and get background checks. No email, password, wallet, or trading access is needed.</p>{turnstileSiteKey && <div id="turnstile-widget" className="turnstile-widget" aria-label="Security check"/>}<button className="primary-button setting-button" onClick={() => void startPrivateSession()} disabled={authLoading || (Boolean(turnstileSiteKey) && !captchaReady)}>{authLoading ? 'Preparing session' : 'Continue privately'}<Icon name="arrow"/></button>{authMessage && <p className="form-note" role="status">{authMessage}</p>}<p className="field-hint">This private session belongs to this browser. Clearing browser data means you cannot return to it.</p></div></section>}
          {(!backendConfigured || hostedMode) && !address && <section className="connect-panel">
            <div className="connect-art" aria-hidden="true"><div className="orb orb-one"/><div className="orb orb-two"/><div className="art-ripple ripple-one"/><div className="art-ripple ripple-two"/><span className="art-drop"><Icon name="water"/></span><span className="art-caption">ACCOUNT SIGNAL</span></div>
            <div className="connect-copy"><p className="eyebrow">START MONITORING</p><h2>Bring your account into view</h2><p>Paste a public Hyperliquid account address to read positions and reported liquidation prices. Hydromancer never asks for a private key or permission to trade.</p>
              <form className="address-form" onSubmit={submitAddress} noValidate><label htmlFor="account-address">Public account address</label><div className="input-row"><input id="account-address" value={input} onChange={(event) => { setInput(event.target.value); setFormError('') }} placeholder="0x followed by 40 characters" autoComplete="off" spellCheck={false}/><button className="primary-button" type="submit" disabled={monitorLoading}>{monitorLoading ? 'Saving' : hostedMode ? 'Save monitor' : 'Connect'} <Icon name="arrow"/></button></div>{formError && <p className="form-error" role="alert">{formError}</p>}<p className="field-hint">{hostedMode ? 'Your public address is stored privately and read by the monitor service.' : 'Your address stays in this browser. Only public account data is requested.'}</p></form>
            </div>
          </section>}

          {(!backendConfigured || hostedMode) && address && <>
            <section className="account-strip"><div className="account-ident"><span className="account-icon"><Icon name="shield"/></span><div><span className="eyebrow">MONITORED ACCOUNT</span><strong>{shortAddress(address)}</strong></div></div><div className="account-actions"><span className="source-tag"><i className={serverHealthy || !backendConfigured ? 'dot good' : 'dot warn'}/>{backendConfigured ? serverMonitor?.last_error ? 'Server check needs attention' : serverCheckAge !== null && serverCheckAge < 120 ? `Server checked ${serverCheckAge}s ago` : serverMonitor?.last_checked_at ? 'Server check overdue' : 'Waiting for first server check' : 'Live HyperCore source'}</span><button className="quiet-button" onClick={() => void refreshAccount()} disabled={syncing}>{syncing ? 'Refreshing' : 'Refresh now'}</button></div></section>
            {syncError && <div className="error-banner" role="alert"><strong>Account refresh failed</strong><span>{syncError} The last successful data remains visible with its update time.</span><button onClick={() => void refreshAccount()}>Try again</button></div>}
            {!account && <section className="loading-panel"><span className="loader"/><div><strong>Reading account state</strong><span>Waiting for a response from Hyperliquid mainnet.</span></div></section>}
            {account && <>
              <section className="metric-grid">
                <article className="metric-card hero-metric"><div className="metric-top"><span>Nearest reported liquidation</span><span className={distance && distance.gap <= threshold ? 'risk-tag danger' : distance && distance.gap <= threshold * 2 ? 'risk-tag watch' : 'risk-tag'}>{riskBand}</span></div><div className="metric-value">{distance ? `${distance.gap.toFixed(2)}%` : '—'}</div><div className="metric-bottom">{distance ? `${distance.coin} ${distance.side.toLowerCase()} position` : account.positions.length ? 'Live mark or liquidation price unavailable' : 'No open positions reported'}</div><RiskLine samples={riskSamples} threshold={threshold}/></article>
                <article className="metric-card"><div className="metric-top"><span>Account value</span><span className="metric-icon"><Icon name="activity"/></span></div><div className="metric-value">{money(account.accountValue)}</div><div className="metric-bottom">Reported by Hyperliquid</div></article>
                <article className="metric-card"><div className="metric-top"><span>Maintenance margin</span><span className="metric-icon"><Icon name="shield"/></span></div><div className="metric-value">{money(account.maintenanceMargin)}</div><div className="metric-bottom">Cross maintenance margin reported by Hyperliquid</div></article>
              </section>
              <section className="market-row"><div className="section-title"><div><p className="eyebrow">LIVE MARKET</p><h2>Reference prices</h2></div><span className="live-label"><i className={live ? 'dot good' : 'dot warn'}/>{live ? 'Streaming' : 'Waiting for feed'}</span></div><div className="market-grid">{['BTC','ETH','HYPE'].map((coin) => <div className="market-card" key={coin}><span className="coin-badge">{coin.slice(0,1)}</span><div><span className="market-name">{coin}</span><strong>{mids[coin] ? money(mids[coin]) : 'No live price'}</strong></div><span className="market-status">{mids[coin] ? 'HyperCore' : 'Unavailable'}</span></div>)}</div></section>
              <section className="positions-section"><div className="section-title"><div><p className="eyebrow">ACCOUNT STATE</p><h2>Open positions <span className="count-badge">{account.positions.length}</span></h2></div><span className="data-source">Source: Hyperliquid account state</span></div>
                {account.positions.length ? <div className="table-wrap"><table><thead><tr><th>Market</th><th>Direction</th><th>Position value</th><th>Entry price</th><th>Live mark</th><th>Unrealized PnL</th><th>Reported liquidation</th></tr></thead><tbody>{account.positions.map((position) => { const mark = mids[position.coin]; return <tr key={position.coin}><td><strong className="market-symbol">{position.coin}</strong></td><td><span className={position.size > 0 ? 'side long' : 'side short'}>{position.size > 0 ? 'Long' : 'Short'}</span></td><td>{money(position.value)}</td><td>{position.entryPrice ? money(position.entryPrice) : 'Not provided'}</td><td>{mark ? money(mark) : 'No live price'}</td><td className={position.pnl >= 0 ? 'positive' : 'negative'}>{money(position.pnl)}</td><td>{position.liquidationPrice ? money(position.liquidationPrice) : 'Not provided'}</td></tr>})}</tbody></table></div> : <div className="empty-positions"><span className="empty-icon"><Icon name="pulse"/></span><strong>No open positions</strong><span>Hyperliquid returned no active positions for this account.</span></div>}
              </section>
              <section className="disclosure"><Icon name="shield"/><p><strong>What this signal means</strong> Hydromancer compares live mid prices with liquidation prices returned for each position by Hyperliquid. The nearest percentage distance is a monitoring signal, not a liquidation guarantee or trading recommendation. When prices or account fields are missing, the signal is unavailable instead of estimated.</p></section>
            </>}
          </>}
        </>}

        {backendConfigured && !hostedMode && tab !== 'overview' && <section className="signin-panel"><div className="connect-copy"><p className="eyebrow">PRIVATE GUEST ACCESS</p><h2>Start a private session</h2><p>Use the monitor and save your own alert history without an email or password.</p><button className="primary-button setting-button" onClick={() => void startPrivateSession()} disabled={authLoading}>{authLoading ? 'Preparing session' : 'Continue privately'}<Icon name="arrow"/></button>{authMessage && <p className="form-note" role="status">{authMessage}</p>}</div></section>}
        {tab === 'activity' && (!backendConfigured || hostedMode) && <section className="content-card activity-card"><div className="section-title"><div><p className="eyebrow">{hostedMode ? 'ACCOUNT ALERT HISTORY' : 'BROWSER ALERT HISTORY'}</p><h2>Threshold events</h2></div><button className="quiet-button" onClick={() => void clearActivity()} disabled={!alerts.length}>Clear history</button></div><p className="section-description">{hostedMode ? 'Server recorded threshold events for your private session.' : 'Browser alerts run only while this page is open. This history stays in this browser.'}</p>{alerts.length ? <div className="timeline">{alerts.map((event) => <div className="timeline-item" key={event.id}><span className={event.kind === 'warning' ? 'timeline-icon warning' : 'timeline-icon recovery'}><Icon name={event.kind === 'warning' ? 'bell' : 'shield'}/></span><div className="timeline-copy"><strong>{event.kind === 'warning' ? 'Risk threshold reached' : 'Risk returned below threshold'}</strong><span>{event.message}</span>{hostedMode && <span className="account-event-state">Saved to private session</span>}</div><time>{new Date(event.time).toLocaleString()}</time></div>)}</div> : <div className="empty-positions"><span className="empty-icon"><Icon name="activity"/></span><strong>No alert events yet</strong><span>Threshold events will appear here after live account data crosses your setting.</span></div>}</section>}

        {tab === 'settings' && (!backendConfigured || hostedMode) && <section className="settings-grid"><article className="content-card setting-card"><div className="setting-icon"><Icon name="bell"/></div><p className="eyebrow">RISK DISTANCE</p><h2>Alert threshold</h2><p>Get an alert when any position comes within this percentage distance of its reported liquidation price.</p><div className="threshold-display"><strong>{threshold}%</strong><span>distance to reported liquidation price</span></div><label className="slider-label" htmlFor="risk-threshold">Threshold in percent <span>2% to 30%</span></label><input id="risk-threshold" className="threshold-slider" type="range" min="2" max="30" step="1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); if (hostedMode) setSettingsDirty(true); else setNotice(`Alert threshold saved at ${event.target.value} percent.`) }}/><div className="slider-ends"><span>2% closer</span><span>30% earlier</span></div>{hostedMode && address ? <button className="primary-button setting-button" onClick={() => void saveSettings()} disabled={!settingsDirty || monitorLoading}>{monitorLoading ? 'Saving' : settingsDirty ? 'Save monitor settings' : 'Settings saved'}<Icon name="arrow"/></button> : <div className="setting-saved"><i className="dot good"/>{hostedMode ? 'Save a monitor to keep this setting' : 'Saved in this browser'}</div>}</article>
          <article className="content-card setting-card"><div className="setting-icon"><Icon name="pulse"/></div><p className="eyebrow">ALERT DELIVERY</p><h2>Account and browser alerts</h2><p>{hostedMode ? serverHealthy ? 'Server checks save threshold events to your account, even while this page is closed.' : 'Account alerts start after the database and scheduled monitor are configured.' : 'Guest alerts stay in this browser and work only while the page is open.'}</p><div className="permission-row"><span className={notificationPermission === 'granted' ? 'permission-icon allowed' : 'permission-icon'}><Icon name="bell"/></span><div><strong>{notificationPermission === 'granted' ? 'Browser alerts enabled' : notificationPermission === 'denied' ? 'Browser alerts blocked' : notificationPermission === 'unsupported' ? 'Browser alerts unavailable' : 'Browser alerts not enabled'}</strong><span>{notificationPermission === 'denied' ? 'Change browser site settings to allow notifications.' : 'Optional alerts while this page is open.'}</span></div></div><button className="primary-button setting-button" onClick={() => void enableNotifications()} disabled={notificationPermission === 'granted' || notificationPermission === 'unsupported' || notificationPermission === 'denied'}>{notificationPermission === 'granted' ? 'Enabled' : 'Enable browser alerts'}<Icon name="arrow"/></button></article>
          <article className="content-card setting-card account-setting"><div className="setting-icon"><Icon name="shield"/></div><p className="eyebrow">ACCOUNT PRIVACY</p><h2>Public address only</h2><p>{hostedMode ? 'Your public address and alert history are stored in this private session. The monitor server reads only public Hyperliquid data. No personal information is requested.' : 'Hydromancer sends the address you enter to the public Hyperliquid information API to read its account state. Your address and alert history remain in local browser storage.'}</p>{address ? <div className="saved-address"><span>{shortAddress(address)}</span><button className="quiet-button" onClick={() => void disconnect()}>{hostedMode ? 'Remove monitor' : 'Remove address'}</button></div> : <span className="status-text">No address saved</span>}</article>
        </section>}

        <footer className="page-footer"><span>Hydromancer monitors public HyperCore data</span><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint" target="_blank" rel="noreferrer">Hyperliquid API reference <Icon name="external"/></a></footer>
      </div>
    </main>
  </div>
}

function Landing({ onEnter, address }: { onEnter: () => void; address: string }) {
  return <main className="landing-page">
    <header className="landing-nav"><button className="landing-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><span className="brand-mark"><Icon name="water"/></span>HYDROMANCER</button><nav><a href="#how-it-works">How it works</a><a href="#security">Security</a><button className="nav-cta" onClick={onEnter}>{address ? 'Open monitor' : 'Start monitoring'}<Icon name="arrow"/></button></nav></header>
    <section className="landing-hero">
      <div className="hero-copy"><p className="eyebrow"><i className="dot good"/> BUILT FOR HYPERCORE</p><h1>Know how close<br/>your position is to<br/><em>the edge.</em></h1><p className="hero-summary">Hydromancer watches your Hyperliquid positions against live market prices and the liquidation levels reported by your account.</p><div className="hero-actions"><button className="primary-button hero-button" onClick={onEnter}>{address ? 'Open your monitor' : 'Monitor an account'}<Icon name="arrow"/></button><a className="text-link" href="#how-it-works">See how it works</a></div><div className="hero-proof"><span><Icon name="shield"/> Public data only</span><span><Icon name="pulse"/> Live market feed</span><span><Icon name="water"/> No trade access</span></div></div>
      <div className="hero-visual"><img className="hero-image" src="/hydromancer-hero.svg" alt="Abstract water rings surrounding a monitored market signal"/><div className="hero-image-shade"/><div className="visual-label visual-label-top"><i className="dot good"/> HYPERCORE DATA <span>PUBLIC FEED</span></div><div className="visual-label visual-label-side"><span className="label-orbit"/><span>MARKET<br/>SIGNAL</span></div><div className="visual-caption"><span>01 / ACCOUNT SAFETY</span><span>READ ONLY MONITORING</span></div><div className="visual-line"/></div>
      <div className="hero-bottom"><span>MONITOR THE DISTANCE</span><span className="hero-bottom-line"/><span>MAKE YOUR OWN DECISION</span></div>
    </section>
    <section className="landing-value" id="how-it-works"><div className="value-intro"><p className="eyebrow">CLEAR SIGNALS FROM LIVE DATA</p><h2>Account risk,<br/>without the guesswork.</h2><p>Hydromancer reads public account state from Hyperliquid and compares each live market price with the liquidation price returned for that position.</p></div><div className="value-steps"><article><span className="step-number">01</span><h3>Connect a public address</h3><p>Use an account address. No private key, wallet connection, or trading permission.</p></article><article><span className="step-number">02</span><h3>Watch live positions</h3><p>See market prices, position values, unrealized PnL, and reported liquidation levels.</p></article><article><span className="step-number">03</span><h3>Set your own threshold</h3><p>Choose when Hydromancer should raise a browser alert. Review every event in your activity view.</p></article></div></section>
    <section className="landing-safety" id="security"><div className="safety-mark"><Icon name="shield"/></div><div><p className="eyebrow">DESIGNED TO OBSERVE</p><h2>Your account stays yours.</h2><p>Hydromancer requests public account and market data from Hyperliquid. It never asks for a seed phrase, stores a private key, signs a transaction, or places an order. A private session keeps each visitor's monitor and activity separate.</p></div><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint" target="_blank" rel="noreferrer">Read the API documentation <Icon name="external"/></a></section>
    <footer className="landing-footer"><button className="landing-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><span className="brand-mark"><Icon name="water"/></span>HYDROMANCER</button><span>Independent monitoring for Hyperliquid traders</span><button className="footer-enter" onClick={onEnter}>Open the monitor <Icon name="arrow"/></button></footer>
  </main>
}

function RiskLine({ samples, threshold }: { samples: number[]; threshold: number }) {
  if (samples.length < 2) return <div className="chart-empty">Live observations will draw here after the next account update</div>
  const width = 260
  const height = 48
  const max = Math.max(threshold * 2, ...samples, 1)
  const points = samples.map((value, index) => `${(index / (samples.length - 1)) * width},${height - (Math.min(value, max) / max) * height}`).join(' ')
  const thresholdY = height - (Math.min(threshold, max) / max) * height
  return <div className="risk-chart" aria-label="Observed distance to liquidation over recent account updates"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><line x1="0" x2={width} y1={thresholdY} y2={thresholdY} className="threshold-line"/><polyline points={points} className="risk-polyline"/></svg><span>Recent account observations</span></div>
}

export default App
