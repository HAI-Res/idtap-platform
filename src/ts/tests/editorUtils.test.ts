import { describe, expect, test } from 'vitest';
import {
  isTextEntryTarget,
  isTypingInField,
  parseTimeField,
  goToTimeSeconds,
  seekFraction,
  clampZoomedSize,
  playheadViewStart,
} from '@/comps/editor/editorUtils';

const el = (tagName: string, extra: Record<string, unknown> = {}) =>
  ({ tagName, ...extra });

describe('isTextEntryTarget', () => {
  test('text-like inputs, textarea, select and contenteditable', () => {
    expect(isTextEntryTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTextEntryTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTextEntryTarget(el('INPUT'))).toBe(true);
    expect(isTextEntryTarget(el('TEXTAREA'))).toBe(true);
    expect(isTextEntryTarget(el('SELECT'))).toBe(true);
    expect(isTextEntryTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });
  test('not buttons, checkboxes, ranges or plain elements', () => {
    expect(isTextEntryTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTextEntryTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTextEntryTarget(el('BUTTON'))).toBe(false);
    expect(isTextEntryTarget(el('svg'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget({} as EventTarget)).toBe(false);
  });
});

describe('isTypingInField', () => {
  const input = el('INPUT', { type: 'text' });
  test('blocks editor shortcuts while typing', () => {
    expect(isTypingInField({ target: input, key: 'Backspace' })).toBe(true);
    expect(isTypingInField({ target: input, key: ' ' })).toBe(true);
    expect(isTypingInField({ target: input, key: '3' })).toBe(true);
  });
  test('lets Escape, modifiers and explicitly allowed keys through', () => {
    expect(isTypingInField({ target: input, key: 'Escape' })).toBe(false);
    expect(isTypingInField({ target: input, key: 'Shift' })).toBe(false);
    expect(isTypingInField({ target: input, key: 'Enter' }, ['Enter'])).toBe(false);
    expect(isTypingInField({ target: input, key: 'Enter' })).toBe(true);
  });
  test('never blocks outside text fields', () => {
    expect(isTypingInField({ target: el('svg'), key: 'Backspace' })).toBe(false);
    expect(isTypingInField({ target: el('BUTTON'), key: ' ' })).toBe(false);
  });
});

describe('go-to-time fields (MM:SS)', () => {
  test('parseTimeField treats empty and junk as 0', () => {
    expect(parseTimeField('')).toBe(0);
    expect(parseTimeField('   ')).toBe(0);
    expect(parseTimeField(undefined)).toBe(0);
    expect(parseTimeField('abc')).toBe(0);
    expect(parseTimeField('-4')).toBe(0);
    expect(parseTimeField('07')).toBe(7);
    expect(parseTimeField('2.5')).toBe(2.5);
  });
  test('goToTimeSeconds is minutes*60 + seconds, never NaN', () => {
    expect(goToTimeSeconds('2', '30')).toBe(150);
    expect(goToTimeSeconds('', '45')).toBe(45);
    expect(goToTimeSeconds('1', '')).toBe(60);
    expect(goToTimeSeconds('', '')).toBe(0);
    expect(goToTimeSeconds('0', '90')).toBe(90);
    expect(goToTimeSeconds('10', '0', 300)).toBe(300);
    expect(Number.isNaN(goToTimeSeconds('x', 'y'))).toBe(false);
  });
});

describe('seekFraction', () => {
  test('accounts for the bar left offset', () => {
    expect(seekFraction(150, 100, 200)).toBeCloseTo(0.25);
    expect(seekFraction(100, 100, 200)).toBe(0);
    expect(seekFraction(300, 100, 200)).toBe(1);
  });
  test('clamps to 0..1 and survives a zero-width bar', () => {
    expect(seekFraction(50, 100, 200)).toBe(0);
    expect(seekFraction(500, 100, 200)).toBe(1);
    expect(seekFraction(150, 100, 0)).toBe(0);
  });
});

describe('clampZoomedSize', () => {
  test('zoom in stops at max, zoom out stops at min', () => {
    expect(clampZoomedSize(1000, 1.5, 500, 2000)).toBe(1500);
    expect(clampZoomedSize(1500, 1.5, 500, 2000)).toBe(2000);
    expect(clampZoomedSize(2000, 1.5, 500, 2000)).toBe(2000);
    expect(clampZoomedSize(1000, 1 / 1.5, 500, 2000)).toBe(667);
    expect(clampZoomedSize(600, 1 / 1.5, 500, 2000)).toBe(500);
    expect(clampZoomedSize(500, 1 / 1.5, 500, 2000)).toBe(500);
  });
  test('does not snap an out-of-range size the wrong way', () => {
    // already beyond max (e.g. old saved zoom): zoom in keeps it, zoom out shrinks
    expect(clampZoomedSize(3000, 1.5, 500, 2000)).toBe(3000);
    expect(clampZoomedSize(3000, 1 / 1.5, 500, 2000)).toBe(2000);
    // already below min: zoom out keeps it, zoom in grows
    expect(clampZoomedSize(300, 1 / 1.5, 500, 2000)).toBe(300);
    expect(clampZoomedSize(300, 1.5, 500, 2000)).toBe(450);
  });
});

describe('playheadViewStart', () => {
  test('undefined while the playhead is in view', () => {
    expect(playheadViewStart(15, [10, 30])).toBeUndefined();
    expect(playheadViewStart(10, [10, 30])).toBeUndefined();
    expect(playheadViewStart(30, [10, 30])).toBeUndefined();
  });
  test('jumps when the playhead is right of the view', () => {
    expect(playheadViewStart(31, [10, 30])).toBeCloseTo(28);
  });
  test('jumps when the playhead is left of the view', () => {
    expect(playheadViewStart(2, [10, 30])).toBe(0);
    expect(playheadViewStart(6, [10, 30])).toBeCloseTo(3);
  });
});
