import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { SNIPPET_META as META } from "@/lib/snippet-catalog";

interface Snippet {
  id: string;
  name: string;
  subtitle: string;
  code: string;
}


export async function GET() {
  const dir = path.join(process.cwd(), "remotion", "scenes", "branded");
  const files = await fs.readdir(dir);
  const snippets: Snippet[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".tsx")) continue;
    const id = file.replace(".tsx", "");
    const meta = META[id];
    if (!meta) continue;
    const code = await fs.readFile(path.join(dir, file), "utf-8");
    snippets.push({ id, name: meta.name, subtitle: meta.subtitle, code });
  }
  return NextResponse.json(snippets);
}
