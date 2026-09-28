"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJson = getJson;
exports.getText = getText;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const zlib = __importStar(require("zlib"));
const MAX_REDIRECTS = 5;
/** Read a response body, transparently decompressing gzip/deflate/br. */
function readBody(res) {
    return new Promise((resolve, reject) => {
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream = res;
        try {
            if (encoding === "gzip") {
                stream = res.pipe(zlib.createGunzip());
            }
            else if (encoding === "deflate") {
                stream = res.pipe(zlib.createInflate());
            }
            else if (encoding === "br") {
                stream = res.pipe(zlib.createBrotliDecompress());
            }
        }
        catch (err) {
            reject(err);
            return;
        }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
    });
}
function rawRequest(url, mergedHeaders, timeoutMs, redirectsLeft) {
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
            readBody(res).then((body) => resolve({ status, body }), (err) => reject(err));
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });
        req.on("error", reject);
        req.end();
    });
}
async function getJson(url, headers = {}, timeoutMs = 10000) {
    const mergedHeaders = {
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
        return JSON.parse(body);
    }
    catch (error) {
        const preview = body.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`JSON parse failed for ${url} (body starts: "${preview}"): ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function getText(url, headers = {}, timeoutMs = 10000) {
    const mergedHeaders = {
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
//# sourceMappingURL=http.js.map