/**
 * The largest request body the API reads. The largest one a client sends is a problem report:
 * a 2,000-character description and bounded diagnostics, well under 100 KiB. Caddy refuses
 * larger bodies first in production (apps/web/Caddyfile); this keeps the API safe without it.
 *
 * Effect applies it to the bodies it reads (server.ts provides it as MaxBodySize). A route that
 * hands the request on as a Web Request gets the body as an unlimited stream instead, so wrap
 * its handler in limitingBodySize.
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

type WebHandler = (request: Request) => Promise<Response>;

const tooLarge = () => new Response(null, { status: 413 });

/**
 * `handler`, called with the request's body read into memory up to `maxBytes` and answered 413
 * past it, by its declared length or by the bytes that arrive, without calling `handler`.
 */
export function limitingBodySize(
  handler: WebHandler,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): WebHandler {
  return async (request) => {
    if (request.body === null) return handler(request);

    if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge();

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength;

      if (size > maxBytes) {
        await reader.cancel();

        return tooLarge();
      }

      chunks.push(read.value);
    }

    const body = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return handler(new Request(request, { body }));
  };
}
