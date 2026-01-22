"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUpdateProject, type MountConfig } from "@/data/projects";
import type { Project } from "@/lib/db";

interface ProjectSettingsDialogProps {
  project: Project | null;
  open: boolean;
  onClose: () => void;
  onSave: () => void;
}

function parseMountsJson(json: string | null): MountConfig[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDomainsJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ProjectSettingsDialog({
  project,
  open,
  onClose,
  onSave,
}: ProjectSettingsDialogProps) {
  const [name, setName] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Container defaults
  const [extraMounts, setExtraMounts] = useState<MountConfig[]>([]);
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);

  // New mount/domain input state
  const [newHostPath, setNewHostPath] = useState("");
  const [newContainerPath, setNewContainerPath] = useState("");
  const [newMountMode, setNewMountMode] = useState<"ro" | "rw">("ro");
  const [newDomain, setNewDomain] = useState("");

  const updateProject = useUpdateProject();

  // Initialize form when project changes
  useEffect(() => {
    if (project) {
      setName(project.name);
      setWorkingDirectory(project.working_directory);
      setExtraMounts(parseMountsJson(project.default_extra_mounts));
      setAllowedDomains(parseDomainsJson(project.default_allowed_domains));
    }
  }, [project]);

  const handleAddMount = () => {
    if (!newHostPath.trim() || !newContainerPath.trim()) return;

    const mount: MountConfig = {
      hostPath: newHostPath.trim(),
      containerPath: newContainerPath.trim(),
      mode: newMountMode,
    };

    setExtraMounts([...extraMounts, mount]);
    setNewHostPath("");
    setNewContainerPath("");
    setNewMountMode("ro");
  };

  const handleRemoveMount = (index: number) => {
    setExtraMounts(extraMounts.filter((_, i) => i !== index));
  };

  const handleAddDomain = () => {
    if (!newDomain.trim()) return;

    const domain = newDomain.trim().toLowerCase();
    if (allowedDomains.includes(domain)) return;

    setAllowedDomains([...allowedDomains, domain]);
    setNewDomain("");
  };

  const handleRemoveDomain = (index: number) => {
    setAllowedDomains(allowedDomains.filter((_, i) => i !== index));
  };

  const handleKeyDown = (
    e: React.KeyboardEvent,
    action: "mount" | "domain"
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (action === "mount") {
        handleAddMount();
      } else {
        handleAddDomain();
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setError(null);

    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    setIsLoading(true);
    try {
      // Update project settings using mutation (properly invalidates cache)
      await updateProject.mutateAsync({
        projectId: project.id,
        name: name.trim(),
        workingDirectory,
        defaultExtraMounts: extraMounts.length > 0 ? extraMounts : undefined,
        defaultAllowedDomains:
          allowedDomains.length > 0 ? allowedDomains : undefined,
      });

      handleClose();
      onSave();
    } catch (err) {
      console.error("Failed to update project:", err);
      setError(err instanceof Error ? err.message : "Failed to update project");
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setError(null);
    setNewHostPath("");
    setNewContainerPath("");
    setNewMountMode("ro");
    setNewDomain("");
    onClose();
  };

  if (!project) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Project Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Project Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
            />
          </div>

          {/* Working Directory */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Working Directory</label>
            <Input
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
              placeholder="~/projects/my-app"
            />
          </div>

          {/* Container Defaults Section */}
          <div className="border-border space-y-4 border-t pt-4">
            <h3 className="text-sm font-medium">
              Default Container Settings
              <span className="text-muted-foreground ml-1 font-normal">
                (for sandboxed sessions)
              </span>
            </h3>

            {/* Extra Mounts */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Default Extra Mounts{" "}
                <span className="text-muted-foreground font-normal">
                  (additional directories)
                </span>
              </label>

              {/* Existing mounts */}
              {extraMounts.length > 0 && (
                <div className="space-y-1">
                  {extraMounts.map((mount, index) => (
                    <div
                      key={index}
                      className="bg-muted flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                    >
                      <span className="flex-1 truncate font-mono text-xs">
                        {mount.hostPath} → {mount.containerPath}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          mount.mode === "rw"
                            ? "bg-amber-500/20 text-amber-600"
                            : "bg-blue-500/20 text-blue-600"
                        }`}
                      >
                        {mount.mode}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveMount(index)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add new mount */}
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <span className="text-muted-foreground text-xs">
                    Host Path
                  </span>
                  <Input
                    value={newHostPath}
                    onChange={(e) => setNewHostPath(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, "mount")}
                    placeholder="~/my-data"
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <span className="text-muted-foreground text-xs">
                    Container Path
                  </span>
                  <Input
                    value={newContainerPath}
                    onChange={(e) => setNewContainerPath(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, "mount")}
                    placeholder="/data"
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <select
                  value={newMountMode}
                  onChange={(e) =>
                    setNewMountMode(e.target.value as "ro" | "rw")
                  }
                  className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                >
                  <option value="ro">Read-only</option>
                  <option value="rw">Read-write</option>
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddMount}
                  disabled={!newHostPath.trim() || !newContainerPath.trim()}
                  className="h-8"
                >
                  Add
                </Button>
              </div>
            </div>

            {/* Allowed Domains */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Default Allowed Domains{" "}
                <span className="text-muted-foreground font-normal">
                  (additional network access)
                </span>
              </label>

              {/* Existing domains */}
              {allowedDomains.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {allowedDomains.map((domain, index) => (
                    <span
                      key={index}
                      className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs"
                    >
                      {domain}
                      <button
                        type="button"
                        onClick={() => handleRemoveDomain(index)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Add new domain */}
              <div className="flex gap-2">
                <Input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, "domain")}
                  placeholder="api.example.com or *.googleapis.com"
                  className="h-8 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddDomain}
                  disabled={!newDomain.trim()}
                  className="h-8"
                >
                  Add
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Common domains (npm, GitHub, Anthropic) are allowed by default
              </p>
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
