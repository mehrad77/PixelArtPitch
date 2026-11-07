declare module "*.css";
interface ImportMetaEnv {
  readonly VITE_PAP_MOCK?: string;
  readonly DEV?: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly dirname: string;
}
