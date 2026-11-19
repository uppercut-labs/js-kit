# @uppercut-labs/react-pwa-install-and-update

React hooks for progressive web apps. `useInstallPrompt` captures the browser's install prompt so you can show your own button, and tracks whether the app is already installed. `useServiceWorkerUpdate` registers a service worker, tells you when a new version is waiting, and applies it. The same registration logic is available without React as `startServiceWorker`.

```sh
npm install @uppercut-labs/react-pwa-install-and-update
```

```tsx
import { useInstallPrompt, useServiceWorkerUpdate } from '@uppercut-labs/react-pwa-install-and-update';

export function PwaBar() {
  const { canInstall, installed, install } = useInstallPrompt();
  const { updateReady, applyUpdate, dismissUpdate } = useServiceWorkerUpdate({
    url: '/sw.js',
    enabled: import.meta.env.PROD,
  });

  return (
    <>
      {canInstall && !installed && <button onClick={() => void install()}>Install app</button>}
      {updateReady && (
        <div role="status">
          A new version is ready.
          <button onClick={applyUpdate}>Reload</button>
          <button onClick={dismissUpdate}>Later</button>
        </div>
      )}
    </>
  );
}
```

`applyUpdate` sends `{ type: 'SKIP_WAITING' }` to the waiting worker, so the worker must call `skipWaiting()` when it receives that message. Once the new worker controls the page, the page reloads.

## useInstallPrompt()

Returns `{ canInstall, installed, install }`.

| Field | Meaning |
| --- | --- |
| `canInstall` | The browser offered an install prompt that has not been used |
| `installed` | Running in standalone display mode, or the user accepted the prompt. Follows display-mode changes and `appinstalled` |
| `install()` | Shows the prompt. Resolves `accepted`, `dismissed`, or `unavailable` when there is no prompt or it failed |

The hook calls `preventDefault` on `beforeinstallprompt` so the browser does not show its own install bar.

## useServiceWorkerUpdate(options)

Returns `{ updateReady, offlineReady, error, applyUpdate, dismissUpdate, dismissOfflineReady, checkForUpdate }`.

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | `/sw.js` | Worker script URL |
| `scope` | browser default | Registration scope |
| `updateViaCache` | `none` | Passed to `register` |
| `enabled` | `true` | Set `false` to skip registration, for example outside production |
| `checkOnRegister` | `true` | Look for a new worker right after registering |
| `checkOnFocus` | `false` | Also look whenever the window regains focus |
| `reloadOnControllerChange` | `true` | Reload when a new worker takes control. The first takeover of an uncontrolled page never reloads, and each page reloads at most once |
| `reload` | `location.reload()` | Replaces the reload call |

| Field | Meaning |
| --- | --- |
| `updateReady` | A new worker finished installing while an older one controls the page |
| `offlineReady` | The first worker finished installing |
| `error` | Message of the last registration or update-check failure |

## Other exports

| Export | Meaning |
| --- | --- |
| `startServiceWorker(options, callbacks)` | The registration logic without React. Callbacks: `onUpdateReady(worker)`, `onOfflineReady()`, `onError(error)`. Returns `{ applyUpdate, checkForUpdate, dispose }` |
| `isStandalone()` | True in standalone display mode or iOS `navigator.standalone` |
| `detectPlatform(ua?)` | `ios`, `android`, `mac`, `windows`, `linux` or `other`, for choosing install instructions |

## License

MIT
