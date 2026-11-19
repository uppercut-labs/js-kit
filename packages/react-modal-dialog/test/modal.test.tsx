// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal, getTabbableElements, lockScroll, useRequestClose } from '../src/index.js';

afterEach(() => {
  cleanup();
  document.body.removeAttribute('style');
});

describe('Modal rendering', () => {
  it('renders a labelled modal dialog in document.body', () => {
    render(
      <Modal title="Settings" onClose={() => {}}>
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('body')).toBe(document.body);
  });

  it('renders nothing when open is false', () => {
    render(
      <Modal title="Settings" open={false} onClose={() => {}}>
        x
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('supports alertdialog, describedBy and class hooks', () => {
    render(
      <Modal
        title="Delete"
        role="alertdialog"
        describedBy="why"
        className="mine"
        backdropClassName="shade"
        actions={<button>OK</button>}
        portal={false}
        onClose={() => {}}
      >
        <p id="why">Cannot be undone</p>
      </Modal>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-describedby')).toBe('why');
    expect(dialog.className).toBe('rmd-dialog mine');
    expect(dialog.parentElement?.className).toBe('rmd-backdrop shade');
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('can hide the close button and rename it', () => {
    const { rerender } = render(
      <Modal title="T" showCloseButton={false} onClose={() => {}} />,
    );
    expect(screen.queryByLabelText('Close dialog')).toBeNull();
    rerender(<Modal title="T" closeLabel="Dismiss" onClose={() => {}} />);
    expect(screen.getByLabelText('Dismiss')).toBeTruthy();
  });
});

describe('closing', () => {
  it('closes on Escape, backdrop press and close button', () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        <button>inner</button>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector('[data-rmd-backdrop]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close when the press starts inside the dialog', () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('respects closeOnEscape and closeOnBackdrop', () => {
    const onClose = vi.fn();
    render(<Modal title="T" closeOnEscape={false} closeOnBackdrop={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('[data-rmd-backdrop]')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores every close request while closeDisabled', () => {
    const onClose = vi.fn();
    render(<Modal title="T" closeDisabled onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('[data-rmd-backdrop]')!);
    expect((screen.getByLabelText('Close dialog') as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets beforeClose veto', () => {
    const onClose = vi.fn();
    let allow = false;
    render(<Modal title="T" beforeClose={() => allow} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    allow = true;
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('useRequestClose goes through the same rules', () => {
    const onClose = vi.fn();
    function Cancel() {
      const request = useRequestClose();
      return <button onClick={request}>Cancel</button>;
    }
    render(
      <Modal title="T" onClose={onClose}>
        <Cancel />
      </Modal>,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the latest onClose without re-registering', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Modal title="T" onClose={first} />);
    rerender(<Modal title="T" onClose={second} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('warns before unload only while dirty', () => {
    const { rerender } = render(<Modal title="T" dirty onClose={() => {}} />);
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    rerender(<Modal title="T" dirty={false} onClose={() => {}} />);
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });
});

describe('focus', () => {
  it('focuses the first tabbable body element, falling back to the close button', () => {
    const { unmount } = render(
      <Modal title="T" onClose={() => {}}>
        <input aria-label="name" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('name'));
    unmount();
    render(<Modal title="T" onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Close dialog'));
  });

  it('honors data-autofocus and initialFocus selectors', () => {
    const { unmount } = render(
      <Modal title="T" onClose={() => {}}>
        <input aria-label="a" />
        <input aria-label="b" data-autofocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('b'));
    unmount();
    render(
      <Modal title="T" initialFocus="#second" onClose={() => {}}>
        <input aria-label="a" />
        <input aria-label="b" id="second" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('b'));
  });

  it('restores focus to the opener on close and can skip it', () => {
    function Harness({ restore }: { restore?: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal title="T" open={open} restoreFocus={restore} onClose={() => setOpen(false)}>
            <input aria-label="field" />
          </Modal>
        </>
      );
    }
    const { unmount } = render(<Harness />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('field'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    unmount();

    render(<Harness restore={false} />);
    const second = screen.getByText('Open');
    second.focus();
    fireEvent.click(second);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(second);
  });

  it('traps Tab and Shift+Tab inside the dialog', () => {
    render(
      <Modal title="T" onClose={() => {}}>
        <input aria-label="first" />
        <input aria-label="last" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const close = screen.getByLabelText('Close dialog');
    const last = screen.getByLabelText('last');
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('lets Tab through in the middle and when trapFocus is off', () => {
    render(
      <Modal title="T" trapFocus={false} onClose={() => {}}>
        <input aria-label="only" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    screen.getByLabelText('only').focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    screen.getByLabelText('only').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dialog).toBeTruthy();
  });

  it('keeps focus on the dialog when nothing inside is tabbable', () => {
    render(<Modal title="T" showCloseButton={false} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog);
  });
});

describe('scroll lock', () => {
  it('locks while open and restores the previous overflow', () => {
    document.body.style.overflow = 'scroll';
    const { unmount } = render(<Modal title="T" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('nests: the page unlocks after the last release only', () => {
    const a = lockScroll();
    const b = lockScroll();
    a();
    expect(document.body.style.overflow).toBe('hidden');
    a();
    expect(document.body.style.overflow).toBe('hidden');
    b();
    expect(document.body.style.overflow).toBe('');
  });

  it('can be turned off', () => {
    render(<Modal title="T" lockScroll={false} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('');
  });
});

describe('getTabbableElements', () => {
  it('skips disabled, hidden, negative tabindex and extra radios', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button id="a">a</button>
      <button id="b" disabled>b</button>
      <input id="c" tabindex="-1" />
      <div hidden><input id="d" /></div>
      <input id="e" type="hidden" />
      <input id="f" type="radio" name="g" />
      <input id="h" type="radio" name="g" checked />
      <a id="i" href="#x">i</a>
      <div id="j" tabindex="0">j</div>`;
    document.body.append(root);
    expect(getTabbableElements(root).map((el) => el.id)).toEqual(['a', 'h', 'i', 'j']);
    root.remove();
  });
});
