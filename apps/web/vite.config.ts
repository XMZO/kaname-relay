import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      vue: 'vue/dist/vue.esm-bundler.js',
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/hooks': 'http://127.0.0.1:3000',
    },
  },
});
