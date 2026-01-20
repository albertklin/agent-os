import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GitInfo } from "./NewSessionDialog.types";

interface WorktreeSectionProps {
  gitInfo: GitInfo;
  featureName: string;
  onFeatureNameChange: (value: string) => void;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
}

export function WorktreeSection({
  gitInfo,
  featureName,
  onFeatureNameChange,
  baseBranch,
  onBaseBranchChange,
}: WorktreeSectionProps) {
  return (
    <div className="bg-accent/40 space-y-3 rounded-lg p-3">
      <div className="space-y-1">
        <label className="text-muted-foreground text-xs">Feature Name</label>
        <Input
          value={featureName}
          onChange={(e) => onFeatureNameChange(e.target.value)}
          placeholder="add-dark-mode"
          className="h-8 text-sm"
        />
        {featureName && (
          <p className="text-muted-foreground text-xs">
            Branch: feature/
            {featureName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 50)}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-muted-foreground text-xs">Base Branch</label>
        <Select value={baseBranch} onValueChange={onBaseBranchChange}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {gitInfo.branches.map((branch) => (
              <SelectItem key={branch} value={branch}>
                {branch}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
