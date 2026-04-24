/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  DEV: boolean;
  PROD: boolean;
  MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Global constants injected at build time
declare const __APP_VERSION__: string;
