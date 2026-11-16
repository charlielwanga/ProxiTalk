import type { CapacitorConfig } from '@capacitor/cli';

// Configuration draft only: Capacitor dependencies and native projects are not
// installed yet. `npm run build` creates the static bundle in `dist/`.
const config: CapacitorConfig = {
  appId: 'com.proxitalk.app',
  appName: 'ProxiTalk',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
};

export default config;
