import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host: true so phones on the same wifi can open the page.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, strictPort: true },
});
