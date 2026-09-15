import fs from "fs";
import path from "path";
import { getProject } from "@/lib/projects";
import { isReframedFilename } from "@/lib/reframe";
import { isGradedFilename } from "@/lib/grade";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

interface MediaFile {
  name: string;
  path: string;
  type: "video" | "audio" | "image" | "other";
  size: number;
  sizeFormatted: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function getFileType(ext: string): "video" | "audio" | "image" | "other" {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

function walkDir(dir: string, baseDir: string): MediaFile[] {
  const files: MediaFile[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      if (isReframedFilename(entry.name)) continue; // derived auto-reframe output
      if (isGradedFilename(entry.name)) continue; // derived colour-grade output
      const ext = path.extname(entry.name).toLowerCase();
      const type = getFileType(ext);
      if (type === "other") continue; // Skip non-media files

      const stat = fs.statSync(fullPath);
      const relativePath = path.relative(baseDir, fullPath);
      files.push({
        name: entry.name,
        path: relativePath,
        type,
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
      });
    }
  }
  return files;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project?.mediaFolder) {
    return Response.json({ error: "Project has no media folder" }, { status: 404 });
  }

  if (!fs.existsSync(project.mediaFolder)) {
    return Response.json({ error: "Media folder does not exist", path: project.mediaFolder }, { status: 404 });
  }

  const files = walkDir(project.mediaFolder, project.mediaFolder);

  // Sort: videos first, then by name
  files.sort((a, b) => {
    if (a.type === "video" && b.type !== "video") return -1;
    if (a.type !== "video" && b.type === "video") return 1;
    return a.name.localeCompare(b.name);
  });

  return Response.json({
    folder: project.mediaFolder,
    files,
  });
}
