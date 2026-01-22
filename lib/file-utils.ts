/**
 * Client-safe file utilities (no Node.js dependencies)
 */

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
  children?: FileNode[];
}

/**
 * Media file type detection
 */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
];
const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "mov", "avi", "mkv"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];

export type MediaType = "image" | "video" | "audio" | null;

export function getMediaType(filePath: string): MediaType {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return null;
}

export function isMediaFile(filePath: string): boolean {
  return getMediaType(filePath) !== null;
}

/**
 * Get file extension for syntax highlighting
 */
export function getLanguageFromExtension(ext: string): string {
  const languageMap: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    php: "php",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    vue: "vue",
    svelte: "svelte",
  };

  return languageMap[ext.toLowerCase()] || "plaintext";
}
