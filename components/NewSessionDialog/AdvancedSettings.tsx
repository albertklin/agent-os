import type { AgentType } from "@/lib/providers";
import { getProviderDefinition } from "@/lib/providers";

interface SessionOptionsProps {
  agentType: AgentType;
  skipPermissions: boolean;
  onSkipPermissionsChange: (checked: boolean) => void;
}

export function SessionOptions({
  agentType,
  skipPermissions,
  onSkipPermissionsChange,
}: SessionOptionsProps) {
  const provider = getProviderDefinition(agentType);

  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id="skipPermissions"
        checked={skipPermissions}
        onChange={(e) => onSkipPermissionsChange(e.target.checked)}
        className="border-border bg-background accent-primary h-4 w-4 rounded"
      />
      <label htmlFor="skipPermissions" className="cursor-pointer text-sm">
        Skip permissions
        <span className="text-muted-foreground ml-1">
          {provider.autoApproveFlag
            ? `(${provider.autoApproveFlag})`
            : "(not supported)"}
        </span>
      </label>
    </div>
  );
}
