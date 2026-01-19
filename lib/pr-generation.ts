import { execSync } from "child_process";

export interface GeneratedPRContent {
  title: string;
  description: string;
}

/**
 * Generate PR title and description using heuristics from git context
 */
export function generatePRContent(
  workingDir: string,
  baseBranch: string = "main"
): GeneratedPRContent {
  try {
    // Get git context
    const { diff, commits, changedFiles } = getGitContext(
      workingDir,
      baseBranch
    );

    if (!diff && commits.length === 0) {
      return generateFallbackContent(changedFiles);
    }

    return generateHeuristicContent(diff, commits, changedFiles);
  } catch (error) {
    console.error("Failed to generate PR content", error);
    return generateFallbackContent([]);
  }
}

/**
 * Get git context for PR generation
 */
function getGitContext(
  workingDir: string,
  baseBranch: string
): { diff: string; commits: string[]; changedFiles: string[] } {
  let diff = "";
  let commits: string[] = [];
  let changedFiles: string[] = [];

  try {
    // Try to get the remote base branch reference
    let baseBranchRef = baseBranch;
    try {
      execSync(`git rev-parse --verify origin/${baseBranch}`, {
        cwd: workingDir,
        stdio: "pipe",
      });
      baseBranchRef = `origin/${baseBranch}`;
    } catch {
      // Fall back to local branch
      try {
        execSync(`git rev-parse --verify ${baseBranch}`, {
          cwd: workingDir,
          stdio: "pipe",
        });
      } catch {
        // Base branch doesn't exist
        return { diff, commits, changedFiles };
      }
    }

    // Get diff stats
    try {
      diff = execSync(`git diff ${baseBranchRef}...HEAD --stat`, {
        cwd: workingDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {}

    // Get changed files
    try {
      const filesOut = execSync(
        `git diff --name-only ${baseBranchRef}...HEAD`,
        {
          cwd: workingDir,
          encoding: "utf-8",
        }
      );
      changedFiles = filesOut
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {}

    // Get commit messages
    try {
      const commitsOut = execSync(
        `git log ${baseBranchRef}..HEAD --pretty=format:"%s"`,
        {
          cwd: workingDir,
          encoding: "utf-8",
        }
      );
      commits = commitsOut
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);
    } catch {}

    // Also include uncommitted changes
    try {
      const workingDiff = execSync("git diff --stat", {
        cwd: workingDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (workingDiff) {
        diff = diff ? `${diff}\n${workingDiff}` : workingDiff;
      }

      const uncommittedFiles = execSync("git diff --name-only", {
        cwd: workingDir,
        encoding: "utf-8",
      })
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      changedFiles = [...new Set([...changedFiles, ...uncommittedFiles])];
    } catch {}
  } catch (error) {
    console.warn("Failed to get git context", error);
  }

  return { diff, commits, changedFiles };
}

/**
 * Generate PR content using heuristics
 */
function generateHeuristicContent(
  diff: string,
  commits: string[],
  changedFiles: string[]
): GeneratedPRContent {
  // Use first commit as title
  let title = "chore: update code";
  if (commits.length > 0) {
    title = commits[0];
    if (title.length > 72) {
      title = title.substring(0, 69) + "...";
    }
  } else if (changedFiles.length > 0) {
    const fileName = changedFiles[0].split("/").pop() || "files";
    title = `chore: update ${fileName}`;
  }

  // Build description
  const parts: string[] = [];

  if (commits.length > 0) {
    parts.push("## Changes\n");
    commits.forEach((commit) => parts.push(`- ${commit}`));
  }

  if (changedFiles.length > 0) {
    parts.push("\n## Files Changed\n");
    changedFiles.slice(0, 15).forEach((file) => parts.push(`- \`${file}\``));
    if (changedFiles.length > 15) {
      parts.push(`\n... and ${changedFiles.length - 15} more files`);
    }
  }

  // Parse diff stats
  if (diff) {
    const statsMatch = diff.match(
      /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/
    );
    if (statsMatch) {
      const fileCount = parseInt(statsMatch[1] || "0", 10);
      const insertions = parseInt(statsMatch[2] || "0", 10);
      const deletions = parseInt(statsMatch[3] || "0", 10);

      if (fileCount > 0 || insertions > 0 || deletions > 0) {
        parts.push("\n## Summary\n");
        if (fileCount > 0) {
          parts.push(
            `- ${fileCount} file${fileCount !== 1 ? "s" : ""} changed`
          );
        }
        const changes: string[] = [];
        if (insertions > 0) changes.push(`+${insertions}`);
        if (deletions > 0) changes.push(`-${deletions}`);
        if (changes.length > 0) {
          parts.push(`- ${changes.join(", ")} lines`);
        }
      }
    }
  }

  const description = parts.join("\n") || "No description available.";
  return { title, description };
}

/**
 * Fallback content when no context available
 */
function generateFallbackContent(changedFiles: string[]): GeneratedPRContent {
  const title =
    changedFiles.length > 0
      ? `chore: update ${changedFiles[0].split("/").pop() || "files"}`
      : "chore: update code";

  const description =
    changedFiles.length > 0
      ? `Updated ${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""}.`
      : "No changes detected.";

  return { title, description };
}
