import path from "path";
import fs from "fs";
import { getProject } from "@/lib/projects";
import { gradeWithCache } from "@/lib/grade";

export const runtime = "nodejs";
export const maxDuration = 1800;

/**
 * Bake a colour-grade LUT into one of a project's clips.
 *
 * Returns the derived file's path relative to the media folder, which is what a
 * timeline item stores — so applying a look is, from the document's side, just
 * pointing the clip at a different file. The grade therefore shows in the
 * preview and survives export without the renderer knowing anything about it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const { file, lut } = await request.json();

  if (!file || typeof file !== "string") {
    return Response.json({ error: "file is required" }, { status: 400 });
  }
  if (!lut || typeof lut !== "string") {
    return Response.json({ error: "lut is required" }, { status: 400 });
  }

  const project = getProject(projectId);
  if (!project?.mediaFolder) {
    return Response.json({ error: "Project has no media folder" }, { status: 404 });
  }

  // `file` comes from the client, so keep it inside the project's media folder.
  const root = path.resolve(project.mediaFolder);
  const mediaPath = path.resolve(root, file);
  if (!mediaPath.startsWith(root + path.sep)) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!fs.existsSync(mediaPath)) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const graded = await gradeWithCache(mediaPath, lut);
    return Response.json({
      file: path.relative(root, graded),
      src: `/api/media/${projectId}/${path.relative(root, graded).split(path.sep).join("/")}`,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Grade failed" },
      { status: 500 },
    );
  }
}
