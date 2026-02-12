import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        { src: "manifest.json", dest: "." },
        { src: "public/icon.png", dest: "." }
      ],
    }),
  ],

  resolve: {
    alias: {
      "@aws-nav/shared": path.resolve(
        __dirname,
        "../shared/dist/index.js"
      ),
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      input: {
        content: path.resolve(__dirname, "content/index.tsx"),
        background: path.resolve(__dirname, "background.ts"),
      },
      output: {
        entryFileNames: "[name].js",   // 🔑 NO HASH
        //chunkFileNames: "chunks/[name].js",
        manualChunks: () => null,
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "content.css"; 
          }
          return "assets/[name].[ext]";
        },
      },
    },
  },
})
