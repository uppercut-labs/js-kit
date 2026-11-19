import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { getTabbableElements, nextTrappedFocus } from './focus.js';
import { lockScroll } from './scroll-lock.js';

export interface ModalProps {
  /** Called when the user asks to close (Escape, backdrop, close button). The parent decides whether to unmount. */
  onClose: () => void;
  /** Heading text. It labels the dialog for assistive technology. */
  title: ReactNode;
  children?: ReactNode;
  /** Renders nothing when false. Default true, so conditional mounting also works. */
  open?: boolean;
  /** Footer content such as buttons. */
  actions?: ReactNode;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Close on a press of the backdrop outside the dialog. Default true. */
  closeOnBackdrop?: boolean;
  /** Keep Tab inside the dialog. Default true. */
  trapFocus?: boolean;
  /** Stop the page behind from scrolling. Default true. */
  lockScroll?: boolean;
  /** Return focus to the previously focused element on close. Default true. */
  restoreFocus?: boolean;
  /**
   * Element to focus on open: a CSS selector inside the dialog, or a ref.
   * Default: an element marked `data-autofocus`, else the first tabbable element
   * of the body, else the close button, else the dialog itself.
   */
  initialFocus?: string | RefObject<HTMLElement | null>;
  /** Ignore every close request, for example while a save is in flight. */
  closeDisabled?: boolean;
  /** Unsaved changes: the browser warns before the page is reloaded or closed. */
  dirty?: boolean;
  /** Return false to veto a close request, for example after a declined confirmation. */
  beforeClose?: () => boolean;
  /** `alertdialog` for confirmations that need an answer. Default `dialog`. */
  role?: 'dialog' | 'alertdialog';
  /** Id of an element that describes the dialog. */
  describedBy?: string;
  /** Render the close button in the header. Default true. */
  showCloseButton?: boolean;
  /** Accessible name of the close button. Default `Close dialog`. */
  closeLabel?: string;
  /** Render into `document.body`. Default true. */
  portal?: boolean;
  /** Class names, added after the default `rmd-*` ones. */
  className?: string;
  backdropClassName?: string;
  headerClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  actionsClassName?: string;
  closeButtonClassName?: string;
}

const CloseRequest = createContext<() => void>(() => {});

/** Returns a function that closes the surrounding Modal the way Escape does, honoring `closeDisabled` and `beforeClose`. */
export function useRequestClose(): () => void {
  return useContext(CloseRequest);
}

const cx = (...names: Array<string | undefined>) => names.filter(Boolean).join(' ');

export function Modal(props: ModalProps) {
  const { open = true } = props;
  if (!open) return null;
  return <OpenModal {...props} />;
}

function OpenModal({
  onClose,
  title,
  children,
  actions,
  closeOnEscape = true,
  closeOnBackdrop = true,
  trapFocus = true,
  lockScroll: shouldLockScroll = true,
  restoreFocus = true,
  initialFocus,
  closeDisabled = false,
  dirty = false,
  beforeClose,
  role = 'dialog',
  describedBy,
  showCloseButton = true,
  closeLabel = 'Close dialog',
  portal = true,
  className,
  backdropClassName,
  headerClassName,
  titleClassName,
  bodyClassName,
  actionsClassName,
  closeButtonClassName,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const latest = useRef({ onClose, closeDisabled, beforeClose });
  latest.current = { onClose, closeDisabled, beforeClose };

  const request = useCallback(() => {
    const { onClose: close, closeDisabled: disabled, beforeClose: veto } = latest.current;
    if (disabled) return;
    if (veto && veto() === false) return;
    close();
  }, []);

  // Focus in on open, focus back on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;

    let target: HTMLElement | null = null;
    if (typeof initialFocus === 'string') target = dialog.querySelector<HTMLElement>(initialFocus);
    else if (initialFocus) target = initialFocus.current;
    if (!target) target = dialog.querySelector<HTMLElement>('[data-autofocus]');
    if (!target) {
      const body = dialog.querySelector<HTMLElement>('[data-rmd-body]');
      target = (body && getTabbableElements(body)[0]) || closeRef.current;
    }
    (target ?? dialog).focus();

    return () => {
      if (restoreFocus && previous && previous.isConnected) previous.focus();
    };
    // Initial focus is only decided when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!shouldLockScroll) return;
    return lockScroll();
  }, [shouldLockScroll]);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      request();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeOnEscape, request]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!trapFocus || event.key !== 'Tab' || event.defaultPrevented) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const next = nextTrappedFocus(dialog, document.activeElement, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget) request();
  };

  const node = (
    <div className={cx('rmd-backdrop', backdropClassName)} onMouseDown={onBackdropMouseDown} data-rmd-backdrop="">
      <div
        ref={dialogRef}
        className={cx('rmd-dialog', className)}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={cx('rmd-header', headerClassName)}>
          <h2 id={titleId} className={cx('rmd-title', titleClassName)}>
            {title}
          </h2>
          {showCloseButton ? (
            <button
              ref={closeRef}
              type="button"
              className={cx('rmd-close', closeButtonClassName)}
              aria-label={closeLabel}
              disabled={closeDisabled}
              onClick={request}
            >
              {'×'}
            </button>
          ) : null}
        </div>
        <CloseRequest.Provider value={request}>
          <div className={cx('rmd-body', bodyClassName)} data-rmd-body="">
            {children}
          </div>
          {actions ? <div className={cx('rmd-actions', actionsClassName)}>{actions}</div> : null}
        </CloseRequest.Provider>
      </div>
    </div>
  );

  return portal ? createPortal(node, document.body) : node;
}
