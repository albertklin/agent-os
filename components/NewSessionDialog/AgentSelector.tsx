import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentType } from "@/lib/providers";
import { getProviderDefinition } from "@/lib/providers";
import { AGENT_OPTIONS } from "./NewSessionDialog.types";

interface AgentSelectorProps {
  agentType: AgentType;
  onAgentChange: (value: AgentType) => void;
  model: string;
  onModelChange: (value: string) => void;
}

export function AgentSelector({
  agentType,
  onAgentChange,
  model,
  onModelChange,
}: AgentSelectorProps) {
  const provider = getProviderDefinition(agentType);
  const models = provider.models || [];

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Agent</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          value={agentType}
          onValueChange={(v) => onAgentChange(v as AgentType)}
        >
          <SelectTrigger className="sm:flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="font-medium">{option.label}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {option.description}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {models.length > 0 && (
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
