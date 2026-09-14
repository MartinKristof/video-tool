import fs from "fs";
import path from "path";
import { getProject } from "@/lib/projects";
import { renderThumbnail } from "@/lib/render-queue";
import { getProjectSize } from "@/lib/types";

const PROJECTS_DIR = path.join(process.cwd(), "data", "projects");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const thumbPath = path.join(PROJECTS_DIR, id, "thumbnail.png");

  if (!fs.existsSync(thumbPath)) {
    return new Response(null, { status: 404 });
  }

  const file = fs.readFileSync(thumbPath);
  return new Response(file, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=10",
    },
  });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = getProject(id);
  if (!project || !project.code) {
    return Response.json({ error: "Project not found or has no code" }, { status: 400 });
  }

  const { width, height } = getProjectSize(project.settings);

  try {
    await renderThumbnail(id, project.code, project.settings.fps, width, height, undefined, project.svgContents);
    return Response.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Thumbnail render failed";
    return Response.json({ error: msg }, { status: 500 });
  }
}
