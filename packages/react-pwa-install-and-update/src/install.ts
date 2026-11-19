import { useCallback, useEffect, useRef, useState } from 'react';
import { isStandalone } from './platform.js';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallPrompt {
  /** True once the browser offered an install prompt that has not been used yet. */
  canInstall: boolean;
  /** True when the app runs installed (standalone), or after the user accepted the prompt. */
  installed: boolean;
  /** Shows the browser's install prompt. Resolves with the outcome, or `unavailable` when there is none to show. */
  install(): Promise<InstallOutcome>;
}

/**
 * Captures `beforeinstallprompt` (and calls `preventDefault` so the browser does not show its own mini bar),
 * tracks installed state from the display mode and `appinstalled`, and exposes a deferred `install()`.
 */
export function useInstallPrompt(): InstallPrompt {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandalone());
  const eventRef = useRef<BeforeInstallPromptEvent | null>(null);
  eventRef.current = event;

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
    const onMode = () => setInstalled(isStandalone());
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    mql?.addEventListener?.('change', onMode);
    setInstalled(isStandalone());
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      mql?.removeEventListener?.('change', onMode);
    };
  }, []);

  const install = useCallback(async (): Promise<InstallOutcome> => {
    const current = eventRef.current;
    if (!current) return 'unavailable';
    // A prompt event can be used once, so drop it before waiting for the answer.
    eventRef.current = null;
    setEvent(null);
    try {
      await current.prompt();
      const choice = await current.userChoice;
      if (choice.outcome === 'accepted') setInstalled(true);
      return choice.outcome;
    } catch {
      return 'unavailable';
    }
  }, []);

  return { canInstall: event !== null, installed, install };
}
