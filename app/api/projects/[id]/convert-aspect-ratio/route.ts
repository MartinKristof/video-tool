import Anthropic from "@anthropic-ai/sdk";
import { getProject, createProject, updateProject } from "@/lib/projects";
import type { Orientation, ProjectSettings } from "@/lib/types";
import { getResolution, getProjectSize } from "@/lib/types";

const anthropic = new Anthropic();

export const maxDuration = 300;

const ASPECT_RATIO_TO_ORIENTATION: Record<string, Orientation> = {
  "16:9": "horizontal",
  "9:16": "vertical",
  "1:1": "square",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { aspectRatio } = body as { aspectRatio: string };

  const orientation = ASPECT_RATIO_TO_ORIENTATION[aspectRatio];
  if (!orientation) {
    return Response.json({ error: "Invalid aspect ratio" }, { status: 400 });
  }

  const source = getProject(id);
  if (!source) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  if (!source.code.trim()) {
    return Response.json({ error: "Project has no code to convert" }, { status: 400 });
  }

  // Create the duplicate project with new orientation. A bespoke exact size
  // (settings.width/height) must not carry over — the target is a preset.
  const presetSettings: ProjectSettings = { ...source.settings, orientation };
  delete presetSettings.width;
  delete presetSettings.height;
  const newSettings: ProjectSettings = presetSettings;

  const newProject = createProject({
    name: `${source.name} (${aspectRatio})`,
    animationType: source.animationType,
    settings: newSettings,
    initialPrompt: source.initialPrompt,
    notionContent: source.notionContent,
    scriptWithTimestamps: source.scriptWithTimestamps,
    svgContents: source.svgContents,
  });

  // Build the conversion prompt
  const { width: oldW, height: oldH } = getProjectSize(source.settings);
  const { width: newW, height: newH } = getResolution(newSettings.orientation, newSettings.resolution);

  const scaleX = newW / oldW;
  const scaleY = newH / oldH;

  // Number each line so Claude can reference them precisely
  const numberedCode = source.code
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");

  const systemPrompt = `You are a mechanical find-and-replace tool. You output a JSON array of replacements to reformat Remotion code for a new canvas size.

You MUST output ONLY a raw JSON array. No markdown, no explanation, no code fences, no text before or after. Just [...].

Each entry: {"line": <number>, "old": "<exact substring to find on that line>", "new": "<replacement substring>"}

EXAMPLE — converting from 3840x2160 to 1080x1920:
Input line 47: padding: "36px 40px",
Output: {"line": 47, "old": "36px 40px", "new": "32px 11px"}

Input line 52: fontSize: 72,
Output: {"line": 52, "old": "fontSize: 72", "new": "fontSize: 36"}

Input line 60: const progress = spring({ frame, fps, delay: 30, config: { damping: 200 } });
Output: SKIP — this is animation logic, do NOT touch it.

Input line 71: transform: \`translateY(\${interpolate(progress, [0, 1], [60, 0])}px)\`
Output: SKIP — interpolate output ranges are animation distances, NOT layout.

WHAT TO REPLACE:
- Style pixel values (padding, margin, gap, width, height, borderRadius, fontSize, lineHeight, letterSpacing) — scale them for the new canvas
- Horizontal pixel values: multiply by ${scaleX.toFixed(4)}
- Vertical pixel values: multiply by ${scaleY.toFixed(4)}
- Font sizes and border-radius: multiply by ${Math.min(scaleX, scaleY).toFixed(4)}
- flexDirection "row" → "column" or vice versa ONLY if items would clearly overflow at the new width
- Round all pixel values to the nearest integer

WHAT TO NEVER REPLACE:
- Animation values: spring(), interpolate(), delays, durationInFrames, fps, frame calculations
- Colors, text strings, variable names, component names, data arrays
- Imports, exports, component structure
- Anything inside interpolate() output ranges — those are animation distances, not layout
- opacity, scale, rotate values
- translateX/translateY values inside interpolate() calls

Output the JSON array and nothing else.`;

  const conversionMessage = `Reformat from ${oldW}x${oldH} to ${newW}x${newH}.

${numberedCode}`;

  // Non-streaming: get the full response, apply diffs, then return
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "Analyzing layout changes..." })}\n\n`)
        );

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: "user", content: conversionMessage }],
        });

        const responseText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "Applying changes..." })}\n\n`)
        );

        // Parse the replacements JSON
        // Strip markdown code fences if Claude wrapped it anyway
        const cleanJson = responseText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
        const replacements = JSON.parse(cleanJson) as Array<{
          line: number;
          old: string;
          new: string;
        }>;

        // Apply replacements to the original code
        const lines = source.code.split("\n");
        for (const r of replacements) {
          const idx = r.line - 1;
          if (idx >= 0 && idx < lines.length && lines[idx].includes(r.old)) {
            lines[idx] = lines[idx].replace(r.old, r.new);
          }
        }
        const convertedCode = lines.join("\n");

        // Save the converted code to the new project
        const chatHistory = [
          { role: "user" as const, content: `Converted aspect ratio from ${oldW}x${oldH} to ${newW}x${newH} (${aspectRatio})` },
          { role: "assistant" as const, content: `Applied ${replacements.length} layout adjustments for the new ${newW}x${newH} canvas.` },
        ];
        updateProject(newProject.id, { code: convertedCode, chatHistory });

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true, projectId: newProject.id })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
