/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AUTH0_DOMAIN?: string;
  readonly VITE_AUTH0_CLIENT_ID?: string;
  readonly VITE_AUTH0_AUDIENCE?: string;
  readonly VITE_AUTH0_CALLBACK_URL?: string;
  readonly VITE_AUTH0_SHOW_SOCIAL_LOGIN?: string;
  readonly VITE_PROVISIONING_API_URL?: string;
  readonly VITE_WEBSITE_URL?: string;
  DEV: boolean;
  PROD: boolean;
  MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Global constants injected at build time
declare const __APP_VERSION__: string;
