import { listProjects, createProject } from "@/lib/projects";
import { isValidDoc } from "@/lib/editor-doc";

export async function GET() {
  const projects = listProjects();
  return Response.json(projects);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, animationType, engine, settings, initialPrompt, initialCode, notionContent, scriptWithTimestamps, svgContents, styleMode, topicCardStyle, transitionStyle, useSfx, collectionId, doc } = body;

  // A project may start from a prompt, from code, OR as a timeline. A doc is a
  // complete starting point on its own — requiring a prompt beside it would mean
  // inventing one just to satisfy the check.
  if (!name || !animationType || !settings || (!initialPrompt && !initialCode && !doc)) {
    return Response.json({ error: "name, animationType, settings, and (initialPrompt, initialCode or doc) are required" }, { status: 400 });
  }
  if (doc && !isValidDoc(doc)) {
    return Response.json({ error: "doc has overlapping items on a track" }, { status: 400 });
  }

  const project = createProject({
    name,
    animationType,
    engine,
    settings,
    initialPrompt: initialPrompt ?? "",
    initialCode,
    notionContent,
    scriptWithTimestamps,
    svgContents,
    styleMode,
    topicCardStyle,
    transitionStyle,
    useSfx,
    collectionId,
    doc,
  });
  return Response.json(project);
}
