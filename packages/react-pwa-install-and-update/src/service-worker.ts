import { useCallback, useEffect, useRef, useState } from 'react';

export interface ServiceWorkerOptions {
  /** Script URL. Default `/sw.js`. */
  url?: string;
  /** Registration scope. Default: the browser's default for the script location. */
  scope?: string;
  /** Default `none`, so the browser always revalidates the worker script. */
  updateViaCache?: 'none' | 'imports' | 'all';
  /** Set to false to skip registration, for example outside production: `enabled: import.meta.env.PROD`. Default true. */
  enabled?: boolean;
  /** Ask the browser to look for a new worker right after registering. Default true. */
  checkOnRegister?: boolean;
  /** Also look for a new worker whenever the window regains focus. Default false. */
  checkOnFocus?: boolean;
  /**
   * Reload the page when a new worker takes control. The first takeover of an uncontrolled page is not an update
   * and never reloads. Default true.
   */
  reloadOnControllerChange?: boolean;
  /** Replaces `location.reload()`. */
  reload?: () => void;
}

export interface ServiceWorkerCallbacks {
  /** A new worker finished installing while an old one controls the page. */
  onUpdateReady?: (worker: ServiceWorker) => void;
  /** The first worker finished installing: the app can now run offline. */
  onOfflineReady?: () => void;
  onError?: (error: unknown) => void;
}

export interface ServiceWorkerHandle {
  /** Tells the waiting worker to take over (`{ type: 'SKIP_WAITING' }`). Does nothing when none is waiting. */
  applyUpdate(): void;
  /** Asks the browser to check for a new worker now. */
  checkForUpdate(): Promise<void>;
  /** Removes every listener. The worker itself stays registered. */
  dispose(): void;
}

const idle: ServiceWorkerHandle = {
  applyUpdate() {},
  async checkForUpdate() {},
  dispose() {},
};

/**
 * Framework-free core: registers the worker and reports update and offline readiness through callbacks.
 * Returns a handle immediately; registration finishes in the background.
 */
export function startServiceWorker(
  options: ServiceWorkerOptions = {},
  callbacks: ServiceWorkerCallbacks = {},
): ServiceWorkerHandle {
  const {
    url = '/sw.js',
    scope,
    updateViaCache = 'none',
    enabled = true,
    checkOnRegister = true,
    checkOnFocus = false,
    reloadOnControllerChange = true,
    reload = () => location.reload(),
  } = options;
  if (!enabled || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return idle;
  const container = navigator.serviceWorker;

  let disposed = false;
  let registration: ServiceWorkerRegistration | null = null;
  let waiting: ServiceWorker | null = null;
  let controlled = Boolean(container.controller);
  let reloading = false;
  const cleanups: Array<() => void> = [];

  const fail = (error: unknown) => {
    if (!disposed) callbacks.onError?.(error);
  };

  const track = (worker: ServiceWorker) => {
    const onState = () => {
      if (disposed || worker.state !== 'installed') return;
      if (container.controller) {
        waiting = registration?.waiting ?? worker;
        callbacks.onUpdateReady?.(waiting);
      } else {
        callbacks.onOfflineReady?.();
      }
    };
    worker.addEventListener('statechange', onState);
    cleanups.push(() => worker.removeEventListener('statechange', onState));
  };

  const onControllerChange = () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (!reloadOnControllerChange || reloading) return;
    reloading = true;
    reload();
  };
  container.addEventListener('controllerchange', onControllerChange);
  cleanups.push(() => container.removeEventListener('controllerchange', onControllerChange));

  const checkForUpdate = async () => {
    if (!registration) return;
    try {
      await registration.update();
    } catch (error) {
      fail(error);
    }
  };

  const registerOptions: RegistrationOptions = { updateViaCache };
  if (scope !== undefined) registerOptions.scope = scope;

  container
    .register(url, registerOptions)
    .then((reg) => {
      if (disposed) return;
      registration = reg;
      if (reg.waiting && container.controller) {
        waiting = reg.waiting;
        callbacks.onUpdateReady?.(reg.waiting);
      }
      if (reg.installing) track(reg.installing);
      const onFound = () => {
        if (reg.installing) track(reg.installing);
      };
      reg.addEventListener('updatefound', onFound);
      cleanups.push(() => reg.removeEventListener('updatefound', onFound));
      if (checkOnFocus) {
        const onFocus = () => void checkForUpdate();
        window.addEventListener('focus', onFocus);
        cleanups.push(() => window.removeEventListener('focus', onFocus));
      }
      if (checkOnRegister) return checkForUpdate();
    })
    .catch(fail);

  return {
    applyUpdate() {
      waiting?.postMessage({ type: 'SKIP_WAITING' });
    },
    checkForUpdate,
    dispose() {
      disposed = true;
      for (const clean of cleanups.splice(0)) clean();
    },
  };
}

export interface ServiceWorkerUpdate {
  /** A new version is installed and waiting. */
  updateReady: boolean;
  /** The first install finished, so the app works offline. */
  offlineReady: boolean;
  /** Message of the last registration or update-check failure, or null. */
  error: string | null;
  /** Activates the waiting worker; the page reloads when it takes control (see `reloadOnControllerChange`). */
  applyUpdate(): void;
  /** Hides the update prompt until the next update is found. */
  dismissUpdate(): void;
  dismissOfflineReady(): void;
  checkForUpdate(): Promise<void>;
}

/** Registers a service worker and reports when an update is ready, with apply and dismiss actions. */
export function useServiceWorkerUpdate(options: ServiceWorkerOptions = {}): ServiceWorkerUpdate {
  const { url, scope, updateViaCache, enabled, checkOnRegister, checkOnFocus, reloadOnControllerChange } = options;
  const reloadRef = useRef(options.reload);
  reloadRef.current = options.reload;

  const [updateReady, setUpdateReady] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ServiceWorkerHandle>(idle);

  useEffect(() => {
    const next = startServiceWorker(
      {
        url,
        scope,
        updateViaCache,
        enabled,
        checkOnRegister,
        checkOnFocus,
        reloadOnControllerChange,
        reload: () => (reloadRef.current ? reloadRef.current() : location.reload()),
      },
      {
        onUpdateReady: () => setUpdateReady(true),
        onOfflineReady: () => setOfflineReady(true),
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
    handle.current = next;
    return () => {
      next.dispose();
      handle.current = idle;
    };
  }, [url, scope, updateViaCache, enabled, checkOnRegister, checkOnFocus, reloadOnControllerChange]);

  return {
    updateReady,
    offlineReady,
    error,
    applyUpdate: useCallback(() => handle.current.applyUpdate(), []),
    dismissUpdate: useCallback(() => setUpdateReady(false), []),
    dismissOfflineReady: useCallback(() => setOfflineReady(false), []),
    checkForUpdate: useCallback(() => handle.current.checkForUpdate(), []),
  };
}
