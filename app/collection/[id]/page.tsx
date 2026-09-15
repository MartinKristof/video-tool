import Workspace from "@/components/Workspace";

/** One collection's projects, across every type. */
export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workspace collectionId={id} />;
}
