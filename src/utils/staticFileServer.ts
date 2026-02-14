import { FastifyRequest, FastifyReply } from "fastify";
import { readFile, stat } from "fs/promises";
import path from "path";

/**
 * Serve static files from a directory
 * Used as fallback if @fastify/static plugin fails
 */
export async function serveStaticFile(
  request: FastifyRequest,
  reply: FastifyReply,
  staticDir: string
) {
  try {
    // Sanitize the path to prevent directory traversal
    const filePath = path.join(staticDir, request.url.replace(/^\/uploads\//, ""));

    // Security check: ensure the resolved path is within staticDir
    if (!filePath.startsWith(staticDir)) {
      return reply.status(403).send({ error: "Access denied" });
    }

    // Check if file exists
    try {
      await stat(filePath);
    } catch {
      return reply.status(404).send({ error: "File not found" });
    }

    // Read and send the file
    const content = await readFile(filePath);

    // Set content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType = getContentType(ext);
    reply.type(contentType);

    return reply.send(content);
  } catch (error) {
    console.error("Error serving static file:", error);
    return reply.status(500).send({ error: "Internal server error" });
  }
}

/**
 * Get MIME type based on file extension
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
  };

  return types[ext] || "application/octet-stream";
}
