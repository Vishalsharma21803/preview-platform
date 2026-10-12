import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function bearerAuth(expected: string): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const supplied = Buffer.from(token);
    const configured = Buffer.from(expected);
    // Keep comparison timing independent of token contents and avoid logging either value.
    const valid = supplied.length === configured.length && timingSafeEqual(supplied, configured);
    if (!valid) return res.status(header ? 403 : 401).json({ error: header ? "invalid bearer token" : "bearer token required" });
    next();
  };
}
