import { defineConfig } from "vitest/config";

// Preact через автоматический JSX esbuild; в `npm run dev` WS и REST проксируются на
// бэкенд (демо: `python -m app.demo --port 8765`). Компонентные тесты (*.test.tsx)
// объявляют окружение `// @vitest-environment happy-dom` у себя в шапке.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8765", ws: true },
      "/api": "http://127.0.0.1:8765",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
