# AgentOS Development Guide

## Common Commands

```bash
npm run dev          # Start development server (port 3011)
npm run build        # Production build
npm run typecheck    # Type check (don't use npx tsc directly)
npm run lint         # Run ESLint
npm run format       # Format with Prettier
```

## Project Structure

- `app/` - Next.js App Router pages and API routes
- `lib/` - Core business logic (sessions, providers, hooks)
- `components/` - React components
- `hooks/` - React hooks (e.g., useStatusStream for SSE)
- `scripts/` - Setup and utility scripts
- `src-tauri/` - Tauri desktop app (optional)

## Key Concepts

**Sessions**: Claude sessions run in tmux, identified by `claude-{uuid}` naming pattern. Session management is in `lib/sessions.ts`.

**Status Updates**: Real-time status via Claude hooks → POST `/api/sessions/status-update` → SSE broadcast at `/api/sessions/status-stream`.

**Database**: SQLite at `~/.agent-os/agentos.db`. Schema in `lib/db.ts`.

## Gotchas

- **Tailscale is required** - The server requires Tailscale for secure remote access. It uses IP filtering to only accept connections from localhost, Docker containers, and Tailscale network. Run `tailscale up` before starting the server.
- **Docker is required** - The server requires Docker for sandboxed sessions. Ensure Docker is running and your user is in the `docker` group.
- **Worktrees need their own node_modules** - Run `npm install --legacy-peer-deps` when starting work in a new worktree
- Use `npm run typecheck` not `npx tsc` - the latter fails with a misleading error
- Claude Code reads hooks from `settings.json`, NOT `hooks.json` - see `lib/hooks/generate-config.ts`
- The dev server runs on port 3011 by default
