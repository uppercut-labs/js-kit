# @uppercut-labs/react-modal-dialog

An accessible modal dialog for React. It traps focus, locks page scroll, restores focus to the element that opened it, closes on Escape or a press on the backdrop, and labels the dialog with its title. It ships without styling; an optional small stylesheet is included.

```sh
npm install @uppercut-labs/react-modal-dialog
```

```tsx
import { useState } from 'react';
import { Modal, useRequestClose } from '@uppercut-labs/react-modal-dialog';
import '@uppercut-labs/react-modal-dialog/styles.css'; // optional

function CancelButton() {
  const close = useRequestClose();
  return <button onClick={close}>Cancel</button>;
}

export function Example() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Rename</button>
      <Modal
        open={open}
        title="Rename project"
        onClose={() => setOpen(false)}
        actions={
          <>
            <CancelButton />
            <button form="rename-form">Save</button>
          </>
        }
      >
        <form id="rename-form">
          <input name="name" aria-label="Name" />
        </form>
      </Modal>
    </>
  );
}
```

The dialog renders `div.rmd-backdrop > div.rmd-dialog[role=dialog]` with `.rmd-header`, `.rmd-title`, `.rmd-close`, `.rmd-body` and `.rmd-actions` inside. Add your own classes with the `className` props, or style the `rmd-*` classes directly.

## Modal props

| Prop | Default | Meaning |
| --- | --- | --- |
| `title` | required | Heading; names the dialog |
| `onClose` | required | Called when the user asks to close. You decide whether to unmount |
| `open` | `true` | Renders nothing when `false` |
| `actions` | none | Footer content |
| `closeOnEscape` | `true` | Escape asks to close |
| `closeOnBackdrop` | `true` | A press on the backdrop asks to close |
| `trapFocus` | `true` | Tab and Shift+Tab stay inside the dialog |
| `lockScroll` | `true` | Page behind cannot scroll; nested modals share one lock |
| `restoreFocus` | `true` | Focus returns to the previously focused element |
| `initialFocus` | see below | CSS selector inside the dialog, or a ref |
| `closeDisabled` | `false` | Ignore all close requests, for example while saving |
| `dirty` | `false` | Browser warns before reload or tab close |
| `beforeClose` | none | Return `false` to veto a close request |
| `role` | `dialog` | Or `alertdialog` |
| `describedBy` | none | Id of a describing element |
| `showCloseButton` | `true` | Close button in the header |
| `closeLabel` | `Close dialog` | Accessible name of the close button |
| `portal` | `true` | Render into `document.body` |
| `className`, `backdropClassName`, `headerClassName`, `titleClassName`, `bodyClassName`, `actionsClassName`, `closeButtonClassName` | none | Extra classes |

Initial focus goes to the selector or ref in `initialFocus`, else an element with `data-autofocus`, else the first tabbable element in the body, else the close button, else the dialog.

## Other exports

| Export | Meaning |
| --- | --- |
| `useRequestClose()` | Inside a `Modal`, returns a function that closes it by the same rules as Escape, including `closeDisabled` and `beforeClose` |
| `getTabbableElements(root)` | Elements Tab can reach inside `root`: skips disabled, hidden and `tabindex="-1"` elements, and keeps one radio per group |
| `lockScroll()` | Locks page scroll and returns a release function |

## License

MIT
