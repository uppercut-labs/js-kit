// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectPlatform,
  isStandalone,
  startServiceWorker,
  useInstallPrompt,
  useServiceWorkerUpdate,
} from '../src/index.js';

class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
  setState(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => {});
}

class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration);
}

let container: FakeContainer;

function installContainer() {
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
}

function removeContainer() {
  // @ts-expect-error remove the fake so other tests see no service worker support
  delete navigator.serviceWorker;
}

function fakeInstallEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('platform helpers', () => {
  it('detects platforms from user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectPlatform('curl/8')).toBe('other');
  });

  it('reads standalone from the display mode and iOS navigator.standalone', () => {
    expect(isStandalone()).toBe(false);
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    expect(isStandalone()).toBe(true);
    // @ts-expect-error restore jsdom, which has no matchMedia
    delete window.matchMedia;
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
    // @ts-expect-error cleanup
    delete navigator.standalone;
  });
});

describe('useInstallPrompt', () => {
  it('starts unavailable and not installed', () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
    expect(result.current.installed).toBe(false);
  });

  it('captures the event, prevents the default bar and installs once', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = fakeInstallEvent('accepted');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.canInstall).toBe(true);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.install();
    });
    expect(outcome).toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false);
    expect(result.current.installed).toBe(true);

    await act(async () => {
      outcome = await result.current.install();
    });
    expect(outcome).toBe('unavailable');
  });

  it('reports dismissed without marking installed', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(fakeInstallEvent('dismissed'));
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.install();
    });
    expect(outcome).toBe('dismissed');
    expect(result.current.installed).toBe(false);
  });

  it('returns unavailable when prompt() throws', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = fakeInstallEvent();
    event.prompt = vi.fn(async () => {
      throw new Error('no');
    });
    act(() => {
      window.dispatchEvent(event);
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.install();
    });
    expect(outcome).toBe('unavailable');
  });

  it('marks installed on appinstalled and drops the pending prompt', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(fakeInstallEvent());
    });
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.installed).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it('follows display-mode changes live', () => {
    const listeners: Array<() => void> = [];
    const mql = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    window.matchMedia = vi.fn().mockReturnValue(mql) as never;
    const { result, unmount } = renderHook(() => useInstallPrompt());
    expect(result.current.installed).toBe(false);
    mql.matches = true;
    act(() => listeners.forEach((fn) => fn()));
    expect(result.current.installed).toBe(true);
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalled();
    // @ts-expect-error restore jsdom
    delete window.matchMedia;
  });

  it('stops listening after unmount', () => {
    const { unmount } = renderHook(() => useInstallPrompt());
    unmount();
    const event = fakeInstallEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('startServiceWorker', () => {
  beforeEach(installContainer);
  afterEach(removeContainer);

  it('registers with the url, scope and updateViaCache none by default', async () => {
    startServiceWorker({ scope: '/app/' });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    expect(container.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none', scope: '/app/' });
    await waitFor(() => expect(container.registration.update).toHaveBeenCalledTimes(1));
  });

  it('does nothing when disabled or unsupported', () => {
    const handle = startServiceWorker({ enabled: false });
    expect(container.register).not.toHaveBeenCalled();
    expect(() => handle.applyUpdate()).not.toThrow();
    removeContainer();
    expect(() => startServiceWorker().dispose()).not.toThrow();
  });

  it('can skip the check on register', async () => {
    startServiceWorker({ checkOnRegister: false });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.registration.update).not.toHaveBeenCalled();
  });

  it('reports an update once a new worker installs under a controlling worker', async () => {
    container.controller = {};
    const onUpdateReady = vi.fn();
    startServiceWorker({}, { onUpdateReady });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    await waitFor(() => expect(container.registration.update).toHaveBeenCalled());
    const worker = new FakeWorker();
    container.registration.installing = worker;
    container.registration.waiting = worker;
    container.registration.dispatchEvent(new Event('updatefound'));
    worker.setState('installed');
    expect(onUpdateReady).toHaveBeenCalledWith(worker);
  });

  it('reports a worker already waiting at registration', async () => {
    container.controller = {};
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const onUpdateReady = vi.fn();
    startServiceWorker({}, { onUpdateReady });
    await waitFor(() => expect(onUpdateReady).toHaveBeenCalledWith(waiting));
  });

  it('reports offline readiness for the first install instead of an update', async () => {
    const onUpdateReady = vi.fn();
    const onOfflineReady = vi.fn();
    const worker = new FakeWorker();
    container.registration.installing = worker;
    startServiceWorker({}, { onUpdateReady, onOfflineReady });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    await waitFor(() => expect(container.registration.update).toHaveBeenCalled());
    worker.setState('installed');
    expect(onOfflineReady).toHaveBeenCalledTimes(1);
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('applyUpdate posts SKIP_WAITING to the waiting worker', async () => {
    container.controller = {};
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const onUpdateReady = vi.fn();
    const handle = startServiceWorker({}, { onUpdateReady });
    await waitFor(() => expect(onUpdateReady).toHaveBeenCalled());
    handle.applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('does not reload on the first takeover, then reloads once per later change', async () => {
    const reload = vi.fn();
    startServiceWorker({ reload });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on the first change when the page was already controlled', () => {
    container.controller = {};
    const reload = vi.fn();
    startServiceWorker({ reload });
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when reloadOnControllerChange is false', () => {
    container.controller = {};
    const reload = vi.fn();
    startServiceWorker({ reload, reloadOnControllerChange: false });
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports registration errors', async () => {
    container.register.mockRejectedValueOnce(new Error('blocked'));
    const onError = vi.fn();
    startServiceWorker({}, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0][0] as Error).message).toBe('blocked');
  });

  it('reports update-check failures', async () => {
    container.registration.update.mockRejectedValueOnce(new Error('offline'));
    const onError = vi.fn();
    startServiceWorker({}, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  it('checks on window focus when asked, and stops after dispose', async () => {
    const handle = startServiceWorker({ checkOnFocus: true, checkOnRegister: false });
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    await Promise.resolve();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(container.registration.update).toHaveBeenCalledTimes(1));
    handle.dispose();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(container.registration.update).toHaveBeenCalledTimes(1);
  });

  it('ignores a registration that finishes after dispose', async () => {
    container.controller = {};
    container.registration.waiting = new FakeWorker();
    const onUpdateReady = vi.fn();
    startServiceWorker({}, { onUpdateReady }).dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });
});

describe('useServiceWorkerUpdate', () => {
  beforeEach(installContainer);
  afterEach(removeContainer);

  it('exposes updateReady, applies and dismisses', async () => {
    container.controller = {};
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const { result } = renderHook(() => useServiceWorkerUpdate());
    await waitFor(() => expect(result.current.updateReady).toBe(true));
    act(() => result.current.applyUpdate());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    act(() => result.current.dismissUpdate());
    expect(result.current.updateReady).toBe(false);
  });

  it('exposes offlineReady and error', async () => {
    const worker = new FakeWorker();
    container.registration.installing = worker;
    const { result } = renderHook(() => useServiceWorkerUpdate());
    await waitFor(() => expect(container.registration.update).toHaveBeenCalled());
    act(() => worker.setState('installed'));
    expect(result.current.offlineReady).toBe(true);
    act(() => result.current.dismissOfflineReady());
    expect(result.current.offlineReady).toBe(false);
  });

  it('surfaces a registration error message', async () => {
    container.register.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => useServiceWorkerUpdate());
    await waitFor(() => expect(result.current.error).toBe('nope'));
  });

  it('does not register when disabled and cleans up on unmount', async () => {
    renderHook(() => useServiceWorkerUpdate({ enabled: false }));
    expect(container.register).not.toHaveBeenCalled();

    container.controller = {};
    const reload = vi.fn();
    const { unmount } = renderHook(() => useServiceWorkerUpdate({ reload }));
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    unmount();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('calls the latest reload option', async () => {
    container.controller = {};
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook((p: { reload: () => void }) => useServiceWorkerUpdate({ reload: p.reload }), {
      initialProps: { reload: first },
    });
    rerender({ reload: second });
    container.dispatchEvent(new Event('controllerchange'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
