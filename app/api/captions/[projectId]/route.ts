import path from "path";
import fs from "fs";
import { getProject } from "@/lib/projects";
import { transcribeWithCache } from "@/lib/transcribe";

export const maxDuration = 1800;

/**
 * Turn one of a project's media files into caption tokens.
 *
 * Reuses the project's existing Whisper pipeline rather than sending audio to a
 * hosted API: the transcript is word-level, cached next to the media, and stays
 * on this machine. Times come back in seconds, which is exactly what a captions
 * item stores — so nothing has to be converted or re-timed later.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const { file, model } = await request.json();

  if (!file || typeof file !== "string") {
    return Response.json({ error: "file is required" }, { status: 400 });
  }

  const project = getProject(projectId);
  if (!project?.mediaFolder) {
    return Response.json({ error: "Project has no media folder" }, { status: 404 });
  }

  // Keep the path inside the project's media folder — `file` comes from the client.
  const mediaPath = path.resolve(project.mediaFolder, file);
  if (!mediaPath.startsWith(path.resolve(project.mediaFolder))) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!fs.existsSync(mediaPath)) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const transcript = await transcribeWithCache(mediaPath, { model });
    const tokens = transcript.words.map((w) => ({
      text: w.text.trim(),
      startSec: w.start,
      endSec: w.end,
    })).filter((t) => t.text.length > 0);
    return Response.json({ tokens, durationSeconds: transcript.durationSeconds, language: transcript.language });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Transcription failed" }, { status: 500 });
  }
}
