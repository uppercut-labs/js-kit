import { describe, expect, it } from 'vitest';
import { createInputEventInjector, createProtocolInjector, emulatePageFocus, type InputEventLike } from '../src/index.js';

describe('createInputEventInjector', () => {
  it('sends keyDown, char and keyUp for a character', () => {
    const sent: InputEventLike[] = [];
    createInputEventInjector({ sendInputEvent: (e) => sent.push(e) }).press('a');
    expect(sent).toEqual([
      { type: 'keyDown', keyCode: 'a' },
      { type: 'char', keyCode: 'a' },
      { type: 'keyUp', keyCode: 'a' },
    ]);
  });

  it('names space and newline keys and sends a carriage return for newline', () => {
    const sent: InputEventLike[] = [];
    const injector = createInputEventInjector({ sendInputEvent: (e) => sent.push(e) });
    injector.press(' ');
    injector.press('\n');
    expect(sent.map((e) => `${e.type}:${e.keyCode}`)).toEqual(['keyDown:Space', 'char: ', 'keyUp:Space', 'keyDown:Enter', 'char:\r', 'keyUp:Enter']);
  });

  it('sends a chord with modifiers and no char event', () => {
    const sent: InputEventLike[] = [];
    createInputEventInjector({ sendInputEvent: (e) => sent.push(e) }).press('K', ['meta']);
    expect(sent).toEqual([
      { type: 'keyDown', keyCode: 'K', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'K', modifiers: ['meta'] },
    ]);
  });

  it('sends a named key without a char event', () => {
    const sent: InputEventLike[] = [];
    createInputEventInjector({ sendInputEvent: (e) => sent.push(e) }).press('Escape');
    expect(sent.map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });
});

describe('createProtocolInjector', () => {
  it('dispatches printable keys with text', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    await createProtocolInjector(async (m, p) => void calls.push([m, p])).press('7');
    expect(calls).toEqual([
      ['Input.dispatchKeyEvent', { key: '7', modifiers: 0, type: 'keyDown', text: '7' }],
      ['Input.dispatchKeyEvent', { key: '7', modifiers: 0, type: 'keyUp' }],
    ]);
  });

  it('encodes modifiers as protocol bit flags and omits text', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    await createProtocolInjector(async (_m, p) => void calls.push(p)).press('k', ['control', 'shift']);
    expect(calls[0]).toEqual({ key: 'k', modifiers: 10, type: 'rawKeyDown' });
    expect(calls[1]).toEqual({ key: 'k', modifiers: 10, type: 'keyUp' });
  });

  it('turns a newline into Enter with a carriage return', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    await createProtocolInjector(async (_m, p) => void calls.push(p)).press('\n');
    expect(calls[0]).toMatchObject({ key: 'Enter', text: '\r' });
  });

  it('turns on focus emulation', async () => {
    const calls: unknown[][] = [];
    await emulatePageFocus(async (m, p) => void calls.push([m, p]));
    expect(calls).toEqual([['Emulation.setFocusEmulationEnabled', { enabled: true }]]);
  });
});
