import { describe, it, expect } from 'vitest';
import { readBodyLimited } from './http';

/** A request whose body is a stream of `count` chunks of `size` bytes ('a'). */
function streamingRequest(count: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= count) return controller.close();
        state.pulled++;
        controller.enqueue(new Uint8Array(size).fill(97));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request('https://w.test/x', {
    method: 'POST',
    body,
    // Node needs this for a stream body; Workers ignore it.
    duplex: 'half',
  } as RequestInit);
  return { request, state };
}

function chunkedRequest(chunks: Uint8Array[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request('https://w.test/x', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
}

describe('readBodyLimited', () => {
  it('stops reading a stream as soon as it exceeds the limit (413)', async () => {
    const { request, state } = streamingRequest(100, 1024);
    const res = await readBodyLimited(request, 8 * 1024);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(413);
    expect(await (res as Response).json()).toEqual({
      error: 'Payload too large',
    });
    // 9 chunks of 1 KB exceed 8 KB; allow a little read-ahead, far from 100.
    expect(state.pulled).toBeGreaterThanOrEqual(9);
    expect(state.pulled).toBeLessThan(12);
    expect(state.cancelled).toBe(true);
  });

  it('accepts a stream exactly at the limit', async () => {
    const { request } = streamingRequest(8, 1024);
    const text = await readBodyLimited(request, 8 * 1024);
    expect(text).toBe('a'.repeat(8 * 1024));
  });

  it('decodes UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('Sigur Rós ✓');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "ó"
    const text = await readBodyLimited(
      chunkedRequest([bytes.slice(0, cut), bytes.slice(cut)])
    );
    expect(text).toBe('Sigur Rós ✓');
  });

  it('counts bytes, not characters', async () => {
    const text = 'é'.repeat(5); // 10 bytes
    const res = await readBodyLimited(
      chunkedRequest([new TextEncoder().encode(text)]),
      9
    );
    expect((res as Response).status).toBe(413);
  });

  it('413 from Content-Length before reading', async () => {
    const req = new Request('https://w.test/x', {
      method: 'POST',
      headers: { 'Content-Length': '9000' },
      body: '{}',
    });
    const res = await readBodyLimited(req);
    expect((res as Response).status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  it('empty or absent body is an empty string', async () => {
    expect(
      await readBodyLimited(new Request('https://w.test/x', { method: 'POST' }))
    ).toBe('');
    expect(
      await readBodyLimited(
        new Request('https://w.test/x', { method: 'POST', body: '' })
      )
    ).toBe('');
    expect(await readBodyLimited(new Request('https://w.test/x'))).toBe('');
  });

  it('returns a plain string body under the limit', async () => {
    expect(
      await readBodyLimited(
        new Request('https://w.test/x', { method: 'POST', body: '{"a":1}' })
      )
    ).toBe('{"a":1}');
  });
});
