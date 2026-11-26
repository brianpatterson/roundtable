import { describe, expect, it } from 'vitest';
import { limitingBodySize } from './body-limit.js';

describe('limitingBodySize', () => {
  const seen: string[] = [];

  const handler = limitingBodySize(async (request) => {
    seen.push(await request.text());

    return new Response('handled');
  }, 10);

  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    handler(new Request('http://localhost/api/auth/x', { method: 'POST', body, headers }));

  it('passes a body up to the limit on, unchanged', async () => {
    seen.length = 0;

    expect((await post('0123456789')).status).toBe(200);
    expect(seen).toEqual(['0123456789']);
  });

  it('passes a request without a body on', async () => {
    seen.length = 0;

    expect(await (await post(null)).text()).toBe('handled');
    expect(seen).toEqual(['']);
  });

  it('answers 413 past the limit, without calling the handler', async () => {
    seen.length = 0;

    expect((await post('01234567890')).status).toBe(413);

    // Streamed in chunks with no declared length: counted as they arrive.
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['012345', '67890'])
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

    expect(
      (
        await handler(
          new Request('http://localhost/api/auth/x', {
            method: 'POST',
            body: chunks,
            // @ts-expect-error -- Node needs it for a stream body; the DOM types lack it
            duplex: 'half',
          }),
        )
      ).status,
    ).toBe(413);
    expect(seen).toEqual([]);
  });

  it('answers 413 to a declared length past the limit before reading the body', async () => {
    seen.length = 0;

    const res = await post('short', { 'content-length': '11' });

    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });
});
