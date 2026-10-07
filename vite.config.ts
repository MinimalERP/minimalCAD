import { defineConfig } from "vite";

// base: './' -- so the built dist/ folder works opened straight off disk
// (file://) or served from any subpath, not just a domain root. This is
// what makes "no install, just open it" actually true once built.
export default defineConfig({
  base: "./",
  // Two pages: the editor, and the view-only page MinimalERP frames to show
  // and print an item's drawing (view.html, src/viewer/).
  build: {
    rollupOptions: {
      input: { main: "index.html", view: "view.html" },
    },
  },
  server: {
    open: true,
  },
});
