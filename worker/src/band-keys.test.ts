import { describe, it, expect } from 'vitest';
import {
  normalizeActUrl,
  normalizeName,
  encodeB64Url,
  decodeB64Url,
} from './band-keys';

describe('normalizeActUrl', () => {
  it('lowercases scheme and host, drops query, hash and trailing slashes', () => {
    expect(normalizeActUrl('HTTPS://Band.Example/Tour/?x=1#y')).toBe(
      'https://band.example/Tour'
    );
  });
  it('turns a bare host with a slash into the host alone', () => {
    expect(normalizeActUrl('https://band.example/')).toBe(
      'https://band.example'
    );
  });
  it('keeps a non-default port and drops a default one', () => {
    expect(normalizeActUrl('http://a.example:8080/x/')).toBe(
      'http://a.example:8080/x'
    );
    expect(normalizeActUrl('https://a.example:443/')).toBe('https://a.example');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeActUrl('  https://a.example/b  ')).toBe(
      'https://a.example/b'
    );
  });
  it('rejects non-http(s), garbage and non-strings', () => {
    expect(normalizeActUrl('ftp://a.example')).toBeNull();
    expect(normalizeActUrl('nonsense')).toBeNull();
    expect(normalizeActUrl('')).toBeNull();
    expect(normalizeActUrl(42)).toBeNull();
    expect(normalizeActUrl(null)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeName('Sigur Rós!')).toBe('sigurros');
    expect(normalizeName('AC/DC')).toBe('acdc');
    expect(normalizeName('  The  Band ')).toBe('theband');
  });
  it('returns an empty string for names with no letters or digits', () => {
    expect(normalizeName('!!! ---')).toBe('');
  });
});

describe('base64url helpers', () => {
  it('round-trips unicode text', () => {
    const s = 'https://bänd.example/é?x=1';
    expect(decodeB64Url(encodeB64Url(s))).toBe(s);
  });
  it('produces no padding or url-unsafe characters', () => {
    expect(encodeB64Url('???>>>')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('rejects characters outside the alphabet', () => {
    expect(decodeB64Url('abc*')).toBeNull();
    expect(decodeB64Url('')).toBeNull();
  });
  it('rejects bytes that are not valid UTF-8', () => {
    expect(decodeB64Url('_w')).toBeNull(); // single byte 0xFF
  });
});
