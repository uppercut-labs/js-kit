export { useInstallPrompt, type InstallOutcome, type InstallPrompt } from './install.js';
export {
  startServiceWorker,
  useServiceWorkerUpdate,
  type ServiceWorkerCallbacks,
  type ServiceWorkerHandle,
  type ServiceWorkerOptions,
  type ServiceWorkerUpdate,
} from './service-worker.js';
export { detectPlatform, isStandalone, type Platform } from './platform.js';
