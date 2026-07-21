import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';
import Markdown from 'unplugin-vue-markdown/vite';
import path from 'path';

export default defineConfig(({ command }) => {
  return {
    plugins: [
      Markdown(),
      vue({
        include: [/\.vue$/, /\.md$/],
      }),
      vueDevTools(),
    ],
    // Only include the asset pattern in build mode.
    ...(command === 'build'
      ? { assetsInclude: /src\/audioWorklets\/.*\.worklet\.js$/ }
      : {}),
    build: {
      sourcemap: true,
    },
    optimizeDeps: {
      include: ['vexflow']
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        '@shared': path.resolve(__dirname, './shared'),
        '@model': path.resolve(__dirname, './src/ts/model'),
      },
    },
    test: {
      alias: {
        // server/ code resolves this from server/node_modules when that's
        // installed locally, but CI installs only the root workspace. Pin
        // tests to the root copy so vi.mock and the import agree everywhere.
        'google-auth-library': path.resolve(__dirname, 'node_modules/google-auth-library'),
      },
    },
    server: {
      port: 3000,
    },
  };
});
