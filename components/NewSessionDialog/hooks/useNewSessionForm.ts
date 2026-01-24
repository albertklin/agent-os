import { useState, useEffect, useCallback } from "react";
import type { AgentType } from "@/lib/providers";
import { getProviderDefinition } from "@/lib/providers";
import type { Project } from "@/lib/db";
import { setPendingPrompt } from "@/stores/initialPrompt";
import { useCreateSession, type MountConfig } from "@/data/sessions";
import {
  type GitInfo,
  SKIP_PERMISSIONS_KEY,
  AGENT_TYPE_KEY,
  RECENT_DIRS_KEY,
  USE_WORKTREE_KEY,
  MODEL_KEY_PREFIX,
  MAX_RECENT_DIRS,
  AGENT_OPTIONS,
  generateFeatureName,
} from "../NewSessionDialog.types";
import type { WorktreeSelection } from "../WorktreeSelector";

// Re-export MountConfig for consumers
export type { MountConfig };

// Get the localStorage key for a model setting per agent
function getModelKey(agentType: AgentType): string {
  return `${MODEL_KEY_PREFIX}${agentType}`;
}

// Get the default model for an agent from the provider definition
function getDefaultModel(agentType: AgentType): string {
  const provider = getProviderDefinition(agentType);
  return provider.defaultModel || provider.models?.[0] || "";
}

// Get saved model for an agent, or fall back to default
function getSavedModel(agentType: AgentType): string {
  if (typeof window === "undefined") {
    return getDefaultModel(agentType);
  }
  const saved = localStorage.getItem(getModelKey(agentType));
  if (saved) {
    // Validate that the saved model is still valid for this agent
    const provider = getProviderDefinition(agentType);
    if (provider.models?.includes(saved)) {
      return saved;
    }
  }
  return getDefaultModel(agentType);
}

interface UseNewSessionFormOptions {
  open: boolean;
  projects: Project[];
  selectedProjectId?: string;
  onCreated: (sessionId: string) => void;
  onClose: () => void;
}

export function useNewSessionForm({
  open,
  projects,
  selectedProjectId,
  onCreated,
  onClose,
}: UseNewSessionFormOptions) {
  // React Query mutation
  const createSession = useCreateSession();

  // Form state - name is auto-generated on mount
  const [name, setName] = useState(() => generateFeatureName());
  const [workingDirectory, setWorkingDirectory] = useState("~");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [model, setModel] = useState<string>(() => getSavedModel("claude"));
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState("");

  // NEW: Unified worktree selection state
  const [worktreeSelection, setWorktreeSelection] = useState<WorktreeSelection>(
    {
      branch: "", // Will be populated when git info is available
      mode: "direct",
    }
  );

  // Track if feature name was manually edited
  const [featureNameDirty, setFeatureNameDirty] = useState(false);

  // Git info state
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [checkingGit, setCheckingGit] = useState(false);

  // Container settings state
  const [extraMounts, setExtraMounts] = useState<MountConfig[]>([]);
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);

  // UI state
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

  // Creation step for loading overlay
  // Note: Actual setup progress is now tracked via SSE in the session card
  const [creationStep, setCreationStep] = useState<"creating" | "done">(
    "creating"
  );

  // Recent directories
  const [recentDirs, setRecentDirs] = useState<string[]>([]);

  // Check if working directory is a git repo
  const checkGitRepo = useCallback(async (path: string) => {
    if (!path || path === "~") {
      setGitInfo(null);
      setWorktreeSelection({ branch: "", mode: "direct" });
      return;
    }

    setCheckingGit(true);
    try {
      const res = await fetch("/api/git/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      setGitInfo(data);

      if (data.isGitRepo && data.currentBranch) {
        // Use saved preference for mode, defaulting to isolated for git repos
        const savedUseWorktree = localStorage.getItem(USE_WORKTREE_KEY);
        const preferIsolated =
          savedUseWorktree !== null ? savedUseWorktree === "true" : true;

        // Reset branch - let WorktreeSelector select the default after branches load
        setWorktreeSelection({
          branch: "",
          mode: preferIsolated ? "isolated" : "direct",
          featureName: preferIsolated ? "" : undefined,
        });
        setFeatureNameDirty(false);
      } else {
        setWorktreeSelection({ branch: "", mode: "direct" });
        setFeatureNameDirty(false);
      }
    } catch {
      setGitInfo(null);
      setWorktreeSelection({ branch: "", mode: "direct" });
      setFeatureNameDirty(false);
    } finally {
      setCheckingGit(false);
    }
  }, []);

  // Debounce git check
  useEffect(() => {
    const timer = setTimeout(() => {
      checkGitRepo(workingDirectory);
    }, 500);
    return () => clearTimeout(timer);
  }, [workingDirectory, checkGitRepo]);

  // Sync feature name to session name (unless manually edited) for isolated mode
  useEffect(() => {
    if (worktreeSelection.mode === "isolated" && !featureNameDirty) {
      setWorktreeSelection((prev) => ({
        ...prev,
        featureName: name,
      }));
    }
  }, [name, worktreeSelection.mode, featureNameDirty]);

  // Load preferences from localStorage
  useEffect(() => {
    const savedSkipPerms = localStorage.getItem(SKIP_PERMISSIONS_KEY);
    if (savedSkipPerms !== null) {
      setSkipPermissions(savedSkipPerms === "true");
    }
    const savedAgentType = localStorage.getItem(AGENT_TYPE_KEY);
    if (
      savedAgentType &&
      AGENT_OPTIONS.some((opt) => opt.value === savedAgentType)
    ) {
      setAgentType(savedAgentType as AgentType);
    }
    try {
      const saved = localStorage.getItem(RECENT_DIRS_KEY);
      if (saved) {
        setRecentDirs(JSON.parse(saved));
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Initialize from selectedProjectId when dialog opens
  useEffect(() => {
    if (open && selectedProjectId) {
      setProjectId(selectedProjectId);
      const project = projects.find((p) => p.id === selectedProjectId);
      if (project && !project.is_uncategorized) {
        setWorkingDirectory(project.working_directory);
        // Trigger git check immediately when dialog opens with a project
        checkGitRepo(project.working_directory);
      }
    }
  }, [open, selectedProjectId, projects, checkGitRepo]);

  // Save directory to recent list
  const addRecentDirectory = useCallback((dir: string) => {
    if (!dir || dir === "~") return;
    setRecentDirs((prev) => {
      const filtered = prev.filter((d) => d !== dir);
      const updated = [dir, ...filtered].slice(0, MAX_RECENT_DIRS);
      localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Handlers
  const handleProjectChange = useCallback(
    (newProjectId: string | null) => {
      setProjectId(newProjectId);
      if (newProjectId) {
        const project = projects.find((p) => p.id === newProjectId);
        if (project && !project.is_uncategorized) {
          setWorkingDirectory(project.working_directory);
          // Trigger git check immediately (no debounce) when project is selected
          checkGitRepo(project.working_directory);
        }
      }
    },
    [projects, checkGitRepo]
  );

  const handleSkipPermissionsChange = (checked: boolean) => {
    setSkipPermissions(checked);
    localStorage.setItem(SKIP_PERMISSIONS_KEY, String(checked));
  };

  const handleAgentTypeChange = (value: AgentType) => {
    setAgentType(value);
    localStorage.setItem(AGENT_TYPE_KEY, value);
    // Update model to saved preference for this agent
    setModel(getSavedModel(value));
  };

  const handleModelChange = (value: string) => {
    setModel(value);
    localStorage.setItem(getModelKey(agentType), value);
  };

  // Handler for worktree selection changes
  const handleWorktreeSelectionChange = useCallback(
    (newSelection: WorktreeSelection) => {
      // Track if feature name is being manually edited
      if (
        newSelection.mode === "isolated" &&
        newSelection.featureName !== worktreeSelection.featureName &&
        newSelection.featureName !== name
      ) {
        setFeatureNameDirty(true);
      }

      // Save mode preference
      localStorage.setItem(
        USE_WORKTREE_KEY,
        String(newSelection.mode === "isolated")
      );

      setWorktreeSelection(newSelection);
    },
    [worktreeSelection.featureName, name]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    createSession.reset(); // Clear any previous errors

    // Validate isolated mode requires feature name
    if (worktreeSelection.mode === "isolated") {
      if (!worktreeSelection.featureName?.trim()) {
        return; // Validation handled by button disabled state
      }
      if (!gitInfo?.isGitRepo) {
        return;
      }
    }

    setCreationStep("creating");

    createSession.mutate(
      {
        name: name.trim() || undefined,
        workingDirectory,
        projectId,
        agentType,
        model: model || undefined,
        // NEW: Use worktreeSelection
        worktreeSelection: gitInfo?.isGitRepo ? worktreeSelection : undefined,
        // LEGACY: Keep these for backward compatibility with backend
        useWorktree: worktreeSelection.mode === "isolated",
        featureName:
          worktreeSelection.mode === "isolated"
            ? worktreeSelection.featureName?.trim() || null
            : null,
        baseBranch: null, // Let the backend determine the base branch
        autoApprove: skipPermissions,
        initialPrompt: initialPrompt.trim() || null,
        extraMounts: extraMounts.length > 0 ? extraMounts : undefined,
        allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
      },
      {
        onSuccess: (data) => {
          setCreationStep("done");
          if (data.initialPrompt) {
            setPendingPrompt(data.session.id, data.initialPrompt);
          }
          addRecentDirectory(workingDirectory);
          // Close immediately - setup progress is shown in session card via SSE
          resetForm();
          onCreated(data.session.id);
        },
        onError: () => {
          setCreationStep("creating");
        },
      }
    );
  };

  const resetForm = () => {
    setName(generateFeatureName()); // Regenerate random name
    setWorkingDirectory("~");
    setProjectId(null);
    setWorktreeSelection({ branch: "", mode: "direct" });
    setFeatureNameDirty(false);
    setInitialPrompt("");
    setExtraMounts([]);
    setAllowedDomains([]);
    setCreationStep("creating");
    createSession.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return {
    // Form values
    name,
    setName,
    workingDirectory,
    setWorkingDirectory,
    projectId,
    agentType,
    model,
    skipPermissions,
    initialPrompt,
    setInitialPrompt,
    // NEW: Unified worktree selection
    worktreeSelection,
    setWorktreeSelection: handleWorktreeSelectionChange,
    // Git info
    gitInfo,
    checkingGit,
    // Container settings
    extraMounts,
    setExtraMounts,
    allowedDomains,
    setAllowedDomains,
    // UI
    showDirectoryPicker,
    setShowDirectoryPicker,
    // Submission
    isLoading: createSession.isPending,
    creationStep,
    error: createSession.error?.message ?? null,
    // Recent
    recentDirs,
    // Handlers
    handleProjectChange,
    handleSkipPermissionsChange,
    handleAgentTypeChange,
    handleModelChange,
    handleSubmit,
    handleClose,
  };
}
