import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

// Maximum file size: 10MB (base64 is ~33% larger than binary)
const MAX_BASE64_LENGTH = 10 * 1024 * 1024 * 1.34; // ~13.4MB base64 for 10MB file

export async function POST(request: Request) {
  try {
    const { filename, base64, mimeType } = await request.json();

    if (!base64) {
      return NextResponse.json({ error: "No image data" }, { status: 400 });
    }

    // Validate base64 length before decoding to prevent memory exhaustion
    if (typeof base64 !== "string" || base64.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        { error: `File too large. Maximum size is 10MB.` },
        { status: 413 }
      );
    }

    // Create temp directory for screenshots if it doesn't exist
    const tempDir = path.join(os.tmpdir(), "agent-os-screenshots");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate unique filename
    const ext = mimeType?.split("/")[1] || "png";
    const safeName = filename?.replace(/[^a-zA-Z0-9.-]/g, "_") || "screenshot";
    const uniqueName = `${Date.now()}-${safeName}`;
    const finalName = uniqueName.endsWith(`.${ext}`)
      ? uniqueName
      : `${uniqueName}.${ext}`;
    const filePath = path.join(tempDir, finalName);

    // Decode base64 and write file
    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(filePath, buffer);

    return NextResponse.json({ path: filePath });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to save image" },
      { status: 500 }
    );
  }
}
