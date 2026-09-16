import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  conceptDetail,
  listConcepts,
  uncoveredOutcomes,
} from "@/core/curriculum/concept-admin";
import { PageHeader, Stack } from "@/ui";
import { ConceptEditor } from "./ConceptEditor";

export const metadata: Metadata = { title: "Concept" };

export const dynamic = "force-dynamic";

export default async function ConceptPage({
  params,
}: {
  params: Promise<{ conceptId: string }>;
}) {
  const { conceptId } = await params;
  const [concept, everyConcept] = await Promise.all([
    conceptDetail(conceptId),
    listConcepts(),
  ]);
  if (!concept) notFound();

  // Offered for linking: outcomes nothing measures yet. An outcome already
  // covered by another concept is deliberately NOT offered here — the same
  // answer counting towards two concepts splits the evidence for both, and the
  // weights that would make that honest are a judgement nobody can make from
  // this screen.
  const candidates = await uncoveredOutcomes(undefined, 200);

  return (
    <Stack>
      <PageHeader
        eyebrow={<Link href="/admin/curriculum/concepts">Concepts</Link>}
        title={concept.name}
        description={concept.description ?? undefined}
      />

      <p className="ui-hint tabular">identifier: {concept.slug}</p>

      <ConceptEditor
        conceptId={concept.id}
        outcomes={concept.outcomes}
        candidates={candidates}
        prerequisites={concept.prerequisites}
        requiredBy={concept.requiredBy}
        otherConcepts={everyConcept
          .filter((row) => row.id !== concept.id)
          .map((row) => ({ id: row.id, name: row.name }))}
        chainWarning={concept.chainWarning}
      />
    </Stack>
  );
}
