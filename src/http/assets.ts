import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
export const defaultAssetsRoot = path.resolve(moduleDir, "../app/assets");

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
};

// Entry modules are never content-hashed, so they must never be cached long-term:
// a fresh build must be visible on the next load without a hard reload.
const NO_STORE_NAMES = new Set(["index.js", "index.js.map", "manifest.json"]);
const HASHED_NAME_PATTERN = /-[0-9a-f]{8,}\.[^./]+(\.map)?$/i;

export interface AssetsHandlerOptions {
  root: string;
}

export function createAssetsHandler(options: AssetsHandlerOptions): (
  request: Request,
  response: Response,
  next: NextFunction,
) => void {
  const root = path.resolve(options.root);

  return (request: Request, response: Response, next: NextFunction): void => {
    void handle(request, response, next);
  };

  async function handle(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }

      const rawPath = request.path ?? "/";
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        notFound(response);
        return;
      }
      if (decoded.includes("\0")) {
        notFound(response);
        return;
      }
      const relativePath = decoded.replace(/^\/+/, "");
      if (!relativePath || relativePath === "." || relativePath.endsWith("/")) {
        notFound(response);
        return;
      }
      const segments = relativePath.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        notFound(response);
        return;
      }

      const resolved = path.resolve(root, relativePath);
      if (!isInside(root, resolved)) {
        notFound(response);
        return;
      }

      let info;
      try {
        info = await stat(resolved);
      } catch {
        notFound(response);
        return;
      }
      if (!info.isFile()) {
        notFound(response);
        return;
      }

      // Lexical containment above can still be defeated by a symlink that
      // points outside the asset root; verify the real path too (mirrors
      // Workspace#assertReallyInside).
      let realRoot: string;
      let realResolved: string;
      try {
        [realRoot, realResolved] = await Promise.all([realpath(root), realpath(resolved)]);
      } catch {
        notFound(response);
        return;
      }
      if (!isInside(realRoot, realResolved)) {
        notFound(response);
        return;
      }

      const ext = path.extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const fileName = path.basename(resolved);
      const cacheControl = NO_STORE_NAMES.has(fileName) || !HASHED_NAME_PATTERN.test(fileName)
        ? "no-store"
        : "public, max-age=31536000, immutable";

      response.status(200);
      response.setHeader("content-type", contentType);
      response.setHeader("content-length", String(info.size));
      response.setHeader("cache-control", cacheControl);
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("cross-origin-resource-policy", "cross-origin");
      response.setHeader("x-content-type-options", "nosniff");

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = createReadStream(resolved);
      stream.on("error", (error) => next(error));
      stream.pipe(response);
    } catch (error) {
      next(error);
    }
  }
}

function notFound(response: Response): void {
  response.status(404).json({ error: "ASSET_NOT_FOUND" });
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
