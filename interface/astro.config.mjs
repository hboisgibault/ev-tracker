import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://ev-tracker.com',
  integrations: [react(), sitemap()],
  server: {
    port: 3000,
  }
});
