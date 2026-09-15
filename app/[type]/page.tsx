import { notFound } from "next/navigation";
import Workspace from "@/components/Workspace";
import { ANIMATION_TYPES, normalizeAnimationType } from "@/lib/animation-types";
import type { AnimationType } from "@/lib/types";

/**
 * One kind of project: /animation, /svg, /video, /terminal.
 *
 * A top-level dynamic segment, so anything static — /project, /feedback, /api —
 * still wins. Anything that is not a real type 404s rather than rendering an
 * empty grid, which is the difference between a typo and a lie.
 */
export default async function TypePage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  const wanted = normalizeAnimationType(decodeURIComponent(type).toLowerCase() as AnimationType);
  if (!ANIMATION_TYPES.some((t) => t.id === wanted)) notFound();
  return <Workspace type={wanted} />;
}
