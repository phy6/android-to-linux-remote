import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// A manifest the phone (and the daemon) can compare versions against. CI adds
// files.web (the tarball checksum) after tarring; everything else is known here.
function versionManifest(): Plugin {
  return {
    name: 'taildeck-version',
    generateBundle() {
      let daemon = '0.0.0';
      let daemonSha = '';
      try {
        const src = readFileSync(path.resolve(__dirname, 'public/taildeck-daemon.py'), 'utf-8');
        daemon = /^DAEMON_VERSION\s*=\s*"([^"]+)"/m.exec(src)?.[1] ?? '0.0.0';
        daemonSha = createHash('sha256').update(src).digest('hex');
      } catch {
        // The daemon file is always present in-repo; ignore if it ever is not.
      }
      const manifest = {
        app: pkg.version ?? '0.0.0',
        appSha: (process.env.GITHUB_SHA ?? 'local').slice(0, 7),
        daemon,
        builtAt: new Date().toISOString(),
        files: { daemon: daemonSha },
      };
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(manifest, null, 2) + '\n',
      });
    },
  };
}

export default defineConfig(() => {
  const base = process.env.BASE_PATH || '/';
  const asset = (p: string) => `${base.replace(/\/$/, '')}${p}`;

  return {
    base,
    define: {
      __BUILD_SHA__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'),
      __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      react(),
      tailwindcss(),
      versionManifest(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: base,
          name: 'TailDeck Linux Remote',
          short_name: 'TailDeck',
          description: 'Android Remote Trackpad & Gesture Controller for Linux laptops over Tailscale (Wayland & X11)',
          theme_color: '#090d16',
          background_color: '#090d16',
          display: 'fullscreen',
          display_override: ['fullscreen', 'standalone'],
          orientation: 'portrait',
          start_url: base,
          scope: base,
          icons: [
            {
              src: asset('/pwa-192x192.png'),
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: asset('/pwa-512x512.png'),
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: asset('/pwa-maskable-512x512.png'),
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

