import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";

type Headers = Record<string, string>;

const MAX_REDIRECTS = 5;

/** Read a response body, transparently decompressing gzip/deflate/br. */
function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
    let stream: NodeJS.ReadableStream = res;
    try {
      if (encoding === "gzip") {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "deflate") {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === "br") {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function rawRequest(
  url: string,
  mergedHeaders: Headers,
  timeoutMs: number,
  redirectsLeft: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.request(url, { method: "GET", headers: mergedHeaders }, (res) => {
      const status = res.statusCode ?? 0;

      // Follow redirects
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume(); // drain
        const next = new URL(res.headers.location, url).toString();
        rawRequest(next, mergedHeaders, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      readBody(res).then(
        (body) => resolve({ status, body }),
        (err) => reject(err)
      );
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function getJson<T>(
  url: string,
  headers: Headers = {},
  timeoutMs = 10000
): Promise<T> {
  const mergedHeaders: Headers = {
    "User-Agent": "version-check-vscode",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    ...headers
  };

  const { status, body } = await rawRequest(url, mergedHeaders, timeoutMs, MAX_REDIRECTS);
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} for ${url}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    const preview = body.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `JSON parse failed for ${url} (body starts: "${preview}"): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function getText(
  url: string,
  headers: Headers = {},
  timeoutMs = 10000
): Promise<string> {
  const mergedHeaders: Headers = {
    "User-Agent": "version-check-vscode",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    ...headers
  };

  const { status, body } = await rawRequest(url, mergedHeaders, timeoutMs, MAX_REDIRECTS);
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} for ${url}`);
  }
  return body;
}
