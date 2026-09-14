import fs from "fs";
import path from "path";
import { getProject } from "@/lib/projects";
import { renderThumbnail } from "@/lib/render-queue";
import { getProjectSize } from "@/lib/types";
import { sceneCodeFromDoc } from "@/lib/editor-render";
import { docDuration } from "@/lib/editor-doc";

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
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // A timeline-backed project has no code file, and used to be rejected here —
  // so it sat on the home page with a blank card forever. Render it the same way
  // the export does: wrap the document as a scene that mounts EditorComposition.
  const fromDoc = !project.code?.trim() && project.doc ? project.doc : null;
  if (!fromDoc && !project.code?.trim()) {
    return Response.json({ error: "Project has nothing to render" }, { status: 400 });
  }

  // Root-relative media URLs resolve against the headless bundle server, not
  // this app, so they have to be made absolute first — same as /api/render.
  const origin = new URL(request.url).origin;
  const code = fromDoc
    ? sceneCodeFromDoc(fromDoc).replace(/(["'`])\/api\/media\//g, `$1${origin}/api/media/`)
    : project.code;
  const fps = fromDoc ? fromDoc.size.fps : project.settings.fps;

  const { width, height } = fromDoc
    ? { width: fromDoc.size.width, height: fromDoc.size.height }
    : getProjectSize(project.settings);

  // renderThumbnail defaults to frame 60. A short timeline is over by then, so
  // the card came out plain black — take a frame 40% in instead, which is inside
  // the content and leaves longer videos on the existing frame 60.
  const frame = fromDoc
    ? Math.min(60, Math.max(0, Math.floor(docDuration(fromDoc) * 0.4)))
    : undefined;

  try {
    await renderThumbnail(id, code, fps, width, height, frame, project.svgContents);
    return Response.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Thumbnail render failed";
    return Response.json({ error: msg }, { status: 500 });
  }
}
