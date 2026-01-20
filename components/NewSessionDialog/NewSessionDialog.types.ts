import type { AgentType } from "@/lib/providers";
import type { ProjectWithDevServers } from "@/lib/projects";

// LocalStorage keys
export const SKIP_PERMISSIONS_KEY = "agentOS:skipPermissions";
export const AGENT_TYPE_KEY = "agentOS:defaultAgentType";
export const RECENT_DIRS_KEY = "agentOS:recentDirectories";
export const USE_WORKTREE_KEY = "agentOS:useWorktree";
export const MAX_RECENT_DIRS = 5;

// Model localStorage key prefix (per agent)
export const MODEL_KEY_PREFIX = "agentOS:model:";

// Random feature name generator
const ADJECTIVES = [
  "swift",
  "blue",
  "bright",
  "calm",
  "cool",
  "dark",
  "fast",
  "gold",
  "green",
  "happy",
  "iron",
  "jade",
  "keen",
  "light",
  "loud",
  "mint",
  "neat",
  "nice",
  "pink",
  "pure",
  "quick",
  "red",
  "sage",
  "sharp",
  "slim",
  "soft",
  "warm",
];

const NOUNS = [
  "falcon",
  "river",
  "storm",
  "tiger",
  "wave",
  "cloud",
  "flame",
  "forest",
  "garden",
  "harbor",
  "island",
  "jungle",
  "lake",
  "meadow",
  "ocean",
  "peak",
  "phoenix",
  "rain",
  "shadow",
  "spark",
  "star",
  "stone",
  "sun",
  "thunder",
  "tree",
  "valley",
  "wind",
  "wolf",
];

export function generateFeatureName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

// Git info from API
export interface GitInfo {
  isGitRepo: boolean;
  branches: string[];
  defaultBranch: string | null;
  currentBranch: string | null;
}

// Agent type options
export const AGENT_OPTIONS: {
  value: AgentType;
  label: string;
  description: string;
}[] = [
  { value: "claude", label: "Claude Code", description: "Anthropic's CLI" },
  { value: "codex", label: "Codex", description: "OpenAI's CLI" },
  { value: "opencode", label: "OpenCode", description: "Multi-provider CLI" },
  { value: "gemini", label: "Gemini CLI", description: "Google's CLI" },
  { value: "aider", label: "Aider", description: "AI pair programming" },
  { value: "cursor", label: "Cursor CLI", description: "Cursor's AI agent" },
];

// Props for main dialog
export interface NewSessionDialogProps {
  open: boolean;
  projects: ProjectWithDevServers[];
  selectedProjectId?: string;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

// Form state
export interface NewSessionFormState {
  name: string;
  workingDirectory: string;
  projectId: string | null;
  agentType: AgentType;
  model: string;
  skipPermissions: boolean;
  initialPrompt: string;
  // Worktree
  useWorktree: boolean;
  featureName: string;
  baseBranch: string;
  // Git
  gitInfo: GitInfo | null;
  checkingGit: boolean;
  // Submission
  isLoading: boolean;
  error: string | null;
  // Recent
  recentDirs: string[];
}
