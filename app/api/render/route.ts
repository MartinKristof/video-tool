import { enqueueRender } from "@/lib/render-queue";
import type { RenderCodec } from "@/lib/render-queue";
import { getProject } from "@/lib/projects";
import { resolveLutPath } from "@/lib/luts";
import { sceneCodeFromDoc } from "@/lib/editor-render";
import { docDuration } from "@/lib/editor-doc";

export async function POST(request: Request) {
  const body = await request.json();
  const { sceneId, codec, projectId, lut } = body;
  let { durationInFrames, fps, width, height } = body;
  let code: string = body.code;

  // A document project exports the DOCUMENT, not the legacy code field it still
  // carries. Prefer the copy the client just sent (the editor saves on a
  // debounce, so the stored one can lag by a couple of seconds) and fall back to
  // what is on disk. Length and size come from the document too.
  const storedDoc = projectId ? getProject(projectId)?.doc : undefined;
  const doc = body.doc ?? storedDoc;
  if (doc) {
    code = sceneCodeFromDoc(doc);
    durationInFrames = docDuration(doc);
    fps = doc.size.fps;
    width = doc.size.width;
    height = doc.size.height;
  }

  if (!code) {
    return Response.json({ error: "code is required" }, { status: 400 });
  }

  // Headless rendering serves the Remotion bundle on its OWN port (e.g. :3001 when
  // Next holds :3000), so any root-relative "/api/media/..." src would resolve
  // against that bundle server and 404. Rewrite media URLs to absolute against this
  // app's real origin so the renderer can fetch the uploaded footage. (No-op for
  // scenes without media, e.g. pure animations.)
  const origin = new URL(request.url).origin;
  code = code.replace(/(["'`])\/api\/media\//g, `$1${origin}/api/media/`);

  const codecMap: Record<string, RenderCodec> = { h264: "h264", prores: "prores", "prores-xq": "prores-xq", uncompressed: "uncompressed", qtrle: "qtrle", "hevc-alpha": "hevc-alpha" };
  const validCodec: RenderCodec = codecMap[codec] || "h264";
  const svgContents = projectId ? getProject(projectId)?.svgContents : undefined;
  // Resolve the picker id to a safe absolute .cube path (null if none/invalid).
  // The LUT grade is applied only to the opaque h264 export (see render-queue).
  const lutPath = validCodec === "h264" ? (resolveLutPath(lut) ?? undefined) : undefined;
  const job = enqueueRender(sceneId || "untitled", code, durationInFrames || 250, fps || 25, width || 3840, height || 2160, validCodec, svgContents, lutPath);
  return Response.json(job);
}
