import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectWithDevServers } from "@/lib/projects";

interface ProjectSelectorProps {
  projects: ProjectWithDevServers[];
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
}

export function ProjectSelector({
  projects,
  projectId,
  onProjectChange,
}: ProjectSelectorProps) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Project</label>
      <Select
        value={projectId || "none"}
        onValueChange={(v) => onProjectChange(v === "none" ? null : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a project" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">
            <span className="text-muted-foreground">None (uncategorized)</span>
          </SelectItem>
          {projects
            .filter((p) => !p.is_uncategorized)
            .map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
