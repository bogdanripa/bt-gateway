/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_WEB_API_KEY: string;
  readonly VITE_FIREBASE_WEB_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_PUBLIC_URL: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
