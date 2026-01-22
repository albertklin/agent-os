import { NextRequest, NextResponse } from "next/server";
import { readFileSync, statSync } from "fs";
import { extname } from "path";

/**
 * Content type mapping for common media files
 */
const CONTENT_TYPES: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

/**
 * GET /api/files/raw?path=...
 * Serve raw file content with appropriate content type
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    // Expand ~ to home directory
    const expandedPath = path.replace(/^~/, process.env.HOME || "");

    // Check file exists and get size
    const stat = statSync(expandedPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    // Read file content
    const content = readFileSync(expandedPath);

    // Determine content type
    const ext = extname(expandedPath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

    return new NextResponse(content, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": stat.size.toString(),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error serving file:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to serve file",
      },
      { status: 500 }
    );
  }
}
