import { execFileSync } from "node:child_process";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const appVersion = process.env.APP_VERSION ?? execFileSync(
  "git",
  ["describe", "--tags", "--always", "--dirty"],
  { encoding: "utf8" }
).trim();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [sveltekit()],
  server: {
    proxy: {
      "/api": "http://localhost:3000"
    }
  }
});
