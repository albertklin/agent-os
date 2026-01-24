"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Folder,
  Image as ImageIcon,
  ChevronLeft,
  Loader2,
  Home,
  ChevronRight,
  Upload,
  Clipboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/file-utils";
import { uploadFileToTemp } from "@/lib/file-upload";
import { useFileDrop } from "@/hooks/useFileDrop";

// Modal for pasting images on mobile where clipboard API doesn't work
function ImagePasteModal({
  open,
  onClose,
  onImageFile,
}: {
  open: boolean;
  onClose: () => void;
  onImageFile: (file: File) => void;
}) {
  const pasteAreaRef = useRef<HTMLDivElement>(null);

  // Focus the paste area when modal opens
  useEffect(() => {
    if (open && pasteAreaRef.current) {
      const timer = setTimeout(() => {
        pasteAreaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            e.stopPropagation(); // Prevent document-level handler from also firing
            onImageFile(file);
            onClose();
            break;
          }
        }
      }
    },
    [onImageFile, onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background w-[90%] max-w-md rounded-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Paste Image</span>
          <button onClick={onClose} className="hover:bg-muted rounded-md p-1">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="relative h-32 w-full">
          <div
            ref={pasteAreaRef}
            contentEditable
            suppressContentEditableWarning
            onPaste={handlePaste}
            onInput={(e) => {
              // Clear any typed/pasted text content to keep area empty
              const target = e.currentTarget;
              if (target.textContent) {
                target.textContent = "";
              }
            }}
            className="bg-muted focus:ring-primary border-muted-foreground/30 absolute inset-0 flex cursor-text items-center justify-center rounded-lg border-2 border-dashed text-sm focus:ring-2 focus:outline-none"
            aria-label="Tap here, then long-press and select Paste"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-muted-foreground px-4 text-center">
              Tap here, then long-press and select <strong>Paste</strong>
            </span>
          </div>
        </div>
        <p className="text-muted-foreground mt-3 text-center text-xs">
          Copy a screenshot or image first, then paste it here.
        </p>
      </div>
    </div>
  );
}

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
];

interface ImagePickerProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function ImagePicker({
  initialPath,
  onSelect,
  onClose,
}: ImagePickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "~");
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Handle dropped/pasted image file
  const handleImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;

      setUploading(true);
      try {
        const path = await uploadFileToTemp(file);
        if (path) {
          onSelect(path);
        }
      } catch (err) {
        console.error("Failed to upload image:", err);
      } finally {
        setUploading(false);
      }
    },
    [onSelect]
  );

  // Handle explicit clipboard paste - try API first, fall back to modal
  const handleClipboardPaste = useCallback(async () => {
    // Try the async clipboard API first (works on desktop, rarely on mobile)
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const file = new File([blob], "pasted-image.png", {
              type: imageType,
            });
            await handleImageFile(file);
            return;
          }
        }
      }
    } catch {
      // Clipboard API failed - expected on mobile
    }
    // Fall back to paste modal for mobile devices
    setShowPasteModal(true);
  }, [handleImageFile]);

  // Drag and drop using shared hook
  const { isDragging, dragHandlers } = useFileDrop(
    dropZoneRef,
    (file) => {
      if (file.type.startsWith("image/")) {
        handleImageFile(file);
      }
    },
    { disabled: uploading }
  );

  // Clipboard paste handler (skip if paste modal is open - it has its own handler)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Skip if the paste modal is handling this - React's stopPropagation
      // doesn't stop native events from reaching document listeners
      if (showPasteModal) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handleImageFile(file);
            break;
          }
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleImageFile, showPasteModal]);

  // Load directory contents
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setFiles([]);
      } else {
        // Sort: directories first, then files
        const sorted = (data.files || []).sort((a: FileNode, b: FileNode) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });
        setFiles(sorted);
        setCurrentPath(data.path || path);
      }
    } catch {
      setError("Failed to load directory");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirectory(currentPath);
  }, []);

  const navigateTo = (path: string) => {
    loadDirectory(path);
  };

  const navigateUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length > 1) {
      parts.pop();
      navigateTo("/" + parts.join("/"));
    } else {
      navigateTo("/");
    }
  };

  const navigateHome = () => {
    navigateTo("~");
  };

  const handleItemClick = (node: FileNode) => {
    if (node.type === "directory") {
      navigateTo(node.path);
    } else if (isImage(node)) {
      onSelect(node.path);
    }
  };

  const isImage = (node: FileNode) => {
    if (node.type !== "file") return false;
    const ext = node.extension?.toLowerCase() || "";
    return IMAGE_EXTENSIONS.includes(ext);
  };

  // Get path segments for breadcrumb
  const pathSegments = currentPath.split("/").filter(Boolean);

  return (
    <>
      <ImagePasteModal
        open={showPasteModal}
        onClose={() => setShowPasteModal(false)}
        onImageFile={handleImageFile}
      />
      <div className="bg-background fixed inset-0 z-50 flex flex-col">
        {/* Header */}
        <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="h-9 w-9"
          >
            <X className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Select Image</h3>
            <p className="text-muted-foreground truncate text-xs">
              {currentPath}
            </p>
          </div>
        </div>

        {/* Navigation bar */}
        <div className="border-border flex items-center gap-1 overflow-x-auto border-b px-3 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={navigateHome}
            className="h-8 w-8 shrink-0"
            title="Home"
          >
            <Home className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={navigateUp}
            className="h-8 w-8 shrink-0"
            title="Go up"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-muted-foreground flex items-center gap-0.5 overflow-x-auto text-xs">
            <span>/</span>
            {pathSegments.map((segment, i) => (
              <button
                key={i}
                onClick={() =>
                  navigateTo("/" + pathSegments.slice(0, i + 1).join("/"))
                }
                className="hover:text-foreground flex shrink-0 items-center transition-colors"
              >
                <span className="max-w-[100px] truncate">{segment}</span>
                {i < pathSegments.length - 1 && (
                  <ChevronRight className="mx-0.5 h-3 w-3" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Drop Zone */}
        <div
          ref={dropZoneRef}
          {...dragHandlers}
          className={cn(
            "border-border mx-3 mt-3 flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors",
            isDragging && "border-primary bg-primary/10",
            uploading && "opacity-50"
          )}
        >
          {uploading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Uploading...</span>
            </div>
          ) : isDragging ? (
            <div className="flex items-center gap-2">
              <Upload className="text-primary h-5 w-5" />
              <span className="text-primary text-sm font-medium">
                Drop image here
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="text-muted-foreground flex items-center gap-2">
                <Upload className="h-4 w-4" />
                <span className="text-sm">Drop screenshot here</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="default"
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  handleClipboardPaste();
                }}
                onClick={handleClipboardPaste}
                className="gap-1.5"
              >
                <Clipboard className="h-4 w-4" />
                Paste from Clipboard
              </Button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-muted-foreground flex h-32 flex-col items-center justify-center p-4">
              <p className="text-center text-sm">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={navigateUp}
                className="mt-2"
              >
                Go back
              </Button>
            </div>
          ) : files.length === 0 ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center">
              <p className="text-sm">Empty directory</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {files.map((node) => {
                const isImg = isImage(node);
                const isDir = node.type === "directory";
                const isClickable = isImg || isDir;

                return (
                  <button
                    key={node.path}
                    onClick={() => isClickable && handleItemClick(node)}
                    disabled={!isClickable}
                    className={cn(
                      "flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors",
                      isClickable
                        ? "hover:bg-muted/50 hover:border-primary/50 cursor-pointer"
                        : "cursor-not-allowed opacity-40",
                      isImg && "border-primary/30 bg-primary/5"
                    )}
                  >
                    {isDir ? (
                      <Folder className="text-primary/70 h-10 w-10" />
                    ) : isImg ? (
                      <div className="bg-muted flex h-10 w-10 items-center justify-center overflow-hidden rounded">
                        <ImageIcon className="text-primary h-6 w-6" />
                      </div>
                    ) : (
                      <div className="bg-muted/50 flex h-10 w-10 items-center justify-center rounded">
                        <span className="text-muted-foreground text-xs">
                          {node.extension?.toUpperCase() || "?"}
                        </span>
                      </div>
                    )}
                    <span className="w-full truncate text-xs">{node.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-border border-t p-3 text-center">
          <p className="text-muted-foreground text-xs">
            Click an image to select it, or navigate into folders
          </p>
        </div>
      </div>
    </>
  );
}
