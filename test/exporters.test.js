import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimestamp, toSrt, toText, toVtt } from '../server/exporters.js';

const segments = [
  { startMs: 0, endMs: 1_250, original: 'Hello world.', translated: 'Hola, mundo.' },
  { startMs: 1_250, endMs: 3_500, original: 'Open source captions.', translated: 'Subtítulos de código abierto.' },
];

test('formats SRT and VTT timestamps', () => {
  assert.equal(formatTimestamp(3_661_007), '01:01:01,007');
  assert.match(toSrt(segments), /00:00:00,000 --> 00:00:01,250/);
  assert.match(toVtt(segments), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.250/);
});

test('exports the requested language', () => {
  assert.equal(toText(segments, 'original'), 'Hello world.\nOpen source captions.');
  assert.equal(toText(segments, 'translated'), 'Hola, mundo.\nSubtítulos de código abierto.');
});

test('uses original while a translation is pending', () => {
  assert.equal(toText([{ ...segments[0], translated: '' }]), 'Hello world.');
});
