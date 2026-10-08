/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }

interface Window {
  turnstile?: {
    render: (container: HTMLElement, options: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    }) => string
    remove: (widgetId: string) => void
  }
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }

interface Window {
  turnstile?: {
    render: (container: HTMLElement, options: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    }) => string
    remove: (widgetId: string) => void
  }
}
