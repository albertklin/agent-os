import { NextRequest, NextResponse } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
  toggleProjectExpanded,
  updateProjectDefaults,
} from "@/lib/projects";
import { validateMounts, serializeMounts } from "@/lib/mounts";
import {
  validateDomains,
  serializeDomains,
  normalizeDomains,
} from "@/lib/domains";
import type { MountConfig } from "@/lib/db/types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/projects/[id] - Get a single project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    console.error("Error getting project:", error);
    return NextResponse.json(
      { error: "Failed to get project" },
      { status: 500 }
    );
  }
}

// PATCH /api/projects/[id] - Update a project
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      workingDirectory,
      expanded,
      defaultExtraMounts,
      defaultAllowedDomains,
    } = body;

    // Handle expanded toggle separately
    if (typeof expanded === "boolean") {
      toggleProjectExpanded(id, expanded);
    }

    // Update other fields if provided
    if (name || workingDirectory) {
      const project = updateProject(id, {
        name,
        working_directory: workingDirectory,
      });

      if (!project) {
        return NextResponse.json(
          { error: "Project not found or cannot be modified" },
          { status: 404 }
        );
      }
    }

    // Update session defaults if provided
    if (
      defaultExtraMounts !== undefined ||
      defaultAllowedDomains !== undefined
    ) {
      // Validate extra mounts if provided
      if (defaultExtraMounts && defaultExtraMounts.length > 0) {
        const typedMounts: MountConfig[] = defaultExtraMounts;
        const mountsValidation = validateMounts(typedMounts);
        if (!mountsValidation.valid) {
          return NextResponse.json(
            { error: `Invalid mount configuration: ${mountsValidation.error}` },
            { status: 400 }
          );
        }
      }

      // Validate allowed domains if provided
      if (defaultAllowedDomains && defaultAllowedDomains.length > 0) {
        const domainsValidation = validateDomains(defaultAllowedDomains);
        if (!domainsValidation.valid) {
          return NextResponse.json(
            {
              error: `Invalid domain configuration: ${domainsValidation.error}`,
            },
            { status: 400 }
          );
        }
      }

      const result = updateProjectDefaults(id, {
        default_extra_mounts: defaultExtraMounts
          ? serializeMounts(defaultExtraMounts)
          : null,
        default_allowed_domains: defaultAllowedDomains
          ? serializeDomains(normalizeDomains(defaultAllowedDomains))
          : null,
      });

      if (!result) {
        return NextResponse.json(
          { error: "Project not found or cannot be modified" },
          { status: 404 }
        );
      }
    }

    const updated = getProject(id);
    return NextResponse.json({ project: updated });
  } catch (error) {
    console.error("Error updating project:", error);
    return NextResponse.json(
      { error: "Failed to update project" },
      { status: 500 }
    );
  }
}

// DELETE /api/projects/[id] - Delete a project
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const deleted = deleteProject(id);

    if (!deleted) {
      return NextResponse.json(
        { error: "Project not found or cannot be deleted" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting project:", error);
    return NextResponse.json(
      { error: "Failed to delete project" },
      { status: 500 }
    );
  }
}
