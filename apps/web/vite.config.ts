// No imports on purpose: `vite` and `@vitejs/plugin-react` are not installed in this workspace yet, so the config is
// a plain object. JSX uses React's automatic runtime through Oxc (Vite 8), no plugin needed.
export default {
  root: import.meta.dirname,
  server: {
    port: 5140,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:5141", changeOrigin: false } },
  },
  preview: { port: 5140 },
  resolve: { dedupe: ["react", "react-dom"] },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
};
