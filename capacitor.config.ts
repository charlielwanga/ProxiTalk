import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.proxitalk.app',
  appName: 'ProxiTalk',
  webDir: '.',
  server: {
    androidScheme: 'https',
    // Allow Web Bluetooth + WebRTC on the Capacitor origin
    cleartext: false,
  },
  plugins: {
    BluetoothLe: {
      // ProxiTalk Mesh service UUID
      serviceUuid: '0000feaa-0000-1000-8000-00805f9b34fb',
    },
  },
};

export default config;
