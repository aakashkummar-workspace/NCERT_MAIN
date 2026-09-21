import "server-only";
import { unstable_cache } from "next/cache";
import { getSession } from "@/core/identity/context";
import { pickerForBoard } from "@/core/curriculum/picker";
import { organizationBoardId } from "@/core/organizations";

/**
 * questionPickerOptions, cached across requests for a minute.
 *
 * Every chapter and outcome of the school's board is read to fill the question
 * editor's pickers — on the bank, the review queue, a question's page and the
 * builder. Against a database a network hop away that was about 1.6 seconds of
 * every one of those pages, for lists that change only when somebody authors
 * curriculum. A new chapter or outcome therefore reaches a teacher's picker
 * within a minute rather than instantly; nothing about any school is cached,
 * because the curriculum plane has no tenant.
 *
 * The board is cached per organization for the same minute — it changes only
 * through Settings, and never while a class exists on the old one.
 */
const boardFor = (organizationId: string) =>
  unstable_cache(() => organizationBoardId(organizationId), ["board-of", organizationId], {
    revalidate: 60,
  })();

const pickerFor = (boardId: string) =>
  unstable_cache(() => pickerForBoard(boardId), ["question-picker", boardId], {
    revalidate: 60,
    tags: ["curriculum"],
  })();

export async function cachedPickerOptions(organizationId?: string) {
  const orgId = organizationId ?? (await getSession())?.actor.organizationId;
  if (!orgId) throw new Error("cachedPickerOptions: no session");
  return pickerFor(await boardFor(orgId));
}
