import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Project, ProjectMeta, AnimationType, Engine, ProjectSettings, SvgFile, StyleMode, TopicCardStyle, TransitionStyle } from "./types";
import type { EditorDoc } from "./editor-doc";

const PROJECTS_DIR = path.join(process.cwd(), "data", "projects");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function listProjects(): ProjectMeta[] {
  ensureDir(PROJECTS_DIR);
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const projects: ProjectMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(PROJECTS_DIR, entry.name, "project.json");
    if (!fs.existsSync(jsonPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Project;
      projects.push({
        id: raw.id,
        name: raw.name,
        animationType: raw.animationType,
        engine: raw.engine,
        settings: raw.settings,
        initialPrompt: raw.initialPrompt,
        collectionId: raw.collectionId,
        useSfx: raw.useSfx,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      });
    } catch {
      // skip corrupted files
    }
  }

  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): Project | null {
  const jsonPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!fs.existsSync(jsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Project;
  } catch {
    return null;
  }
}

export interface CreateProjectData {
  name: string;
  animationType: AnimationType;
  engine?: Engine;
  settings: ProjectSettings;
  initialPrompt: string;
  initialCode?: string;
  notionContent?: string;
  scriptWithTimestamps?: string;
  svgContents?: SvgFile[];
  styleMode?: StyleMode;
  topicCardStyle?: TopicCardStyle;
  transitionStyle?: TransitionStyle;
  useSfx?: boolean;
  collectionId?: string;
  /**
   * Start the project as a TIMELINE rather than a code file.
   *
   * Until now a document could only be born by converting a finished project
   * with "Open in editor", which is why 5 of 311 projects had one. A project
   * created with a doc opens straight into the visual editor, and its chat
   * edits the timeline instead of writing TSX (ChatPanel branches on this).
   */
  doc?: EditorDoc;
}

export function getProjectMediaDir(id: string): string {
  return path.join(PROJECTS_DIR, id, "media");
}

const STARTER_TAPE = `# A vhs tape — terminal recording as code.
# Docs: https://github.com/charmbracelet/vhs
#
# Output is rendered to out.mp4 by the "Render" button.

Output out.mp4

Set FontSize 22
Set Width 1200
Set Height 600
Set Theme { "background": "#161718", "foreground": "#F4F4F5", "cursor": "#F86606", "selection": "#3D3F43", "black": "#161718", "white": "#F4F4F5" }
Set TypingSpeed 50ms

Type "echo 'Hello from VHS'"
Sleep 500ms
Enter
Sleep 1s

Type "ls -la"
Sleep 500ms
Enter
Sleep 2s
`;

export function createProject(data: CreateProjectData): Project {
  const id = randomUUID();
  const now = new Date().toISOString();

  const projectDir = path.join(PROJECTS_DIR, id);
  ensureDir(projectDir);

  // Video projects get an internal media folder under the project directory.
  // Uploaded files land here; mediaFolder always points to it for the rest of
  // the app (transcribe, /api/media/*, generate) to find files.
  //
  // A doc-backed project gets one too, whatever its type: the timeline accepts
  // footage dropped straight onto a track (DocTimeline's handleDrop posts to
  // /api/media/<id>/upload), and that has nowhere to land without this.
  let mediaFolder: string | undefined;
  if (data.animationType === "video" || data.doc) {
    mediaFolder = getProjectMediaDir(id);
    ensureDir(mediaFolder);
  }

  const project: Project = {
    id,
    name: data.name,
    animationType: data.animationType,
    engine: data.engine ?? "remotion",
    settings: data.settings,
    code:
      data.initialCode != null
        ? data.initialCode
        : data.animationType === "terminal" && !data.initialPrompt
          ? STARTER_TAPE
          : "",
    chatHistory: [],
    initialPrompt: data.initialPrompt,
    notionContent: data.notionContent,
    scriptWithTimestamps: data.scriptWithTimestamps,
    svgContents: data.svgContents,
    mediaFolder,
    styleMode: data.styleMode,
    topicCardStyle: data.topicCardStyle,
    transitionStyle: data.transitionStyle,
    // SFX defaults on for everything except terminal recordings.
    useSfx: data.useSfx ?? data.animationType !== "terminal",
    collectionId: data.collectionId,
    doc: data.doc,
    createdAt: now,
    updatedAt: now,
  };

  fs.writeFileSync(path.join(projectDir, "project.json"), JSON.stringify(project, null, 2), "utf-8");

  return project;
}

export function updateProject(id: string, partial: Partial<Project>): Project | null {
  const existing = getProject(id);
  if (!existing) return null;

  const updated: Project = {
    ...existing,
    ...partial,
    id: existing.id, // prevent overwriting id
    updatedAt: new Date().toISOString(),
  };

  const jsonPath = path.join(PROJECTS_DIR, id, "project.json");
  fs.writeFileSync(jsonPath, JSON.stringify(updated, null, 2), "utf-8");

  return updated;
}

export function duplicateProject(id: string): Project | null {
  const source = getProject(id);
  if (!source) return null;

  const newId = randomUUID();
  const now = new Date().toISOString();

  const duplicate: Project = {
    ...source,
    id: newId,
    name: `${source.name} copy`,
    createdAt: now,
    updatedAt: now,
  };

  const projectDir = path.join(PROJECTS_DIR, newId);
  ensureDir(projectDir);
  fs.writeFileSync(path.join(projectDir, "project.json"), JSON.stringify(duplicate, null, 2), "utf-8");

  return duplicate;
}

export function deleteProject(id: string): boolean {
  const projectDir = path.join(PROJECTS_DIR, id);
  if (!fs.existsSync(projectDir)) return false;

  fs.rmSync(projectDir, { recursive: true, force: true });
  return true;
}
