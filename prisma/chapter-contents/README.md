# Chapter contents

One JSON file per NCERT book (`jemh1.json`, `iesc1.json`, ...). Each describes
what every chapter of that book contains, **read from the book itself** — the
chapter PDFs in `C:\dev\sirah_project\NCERT\data\ncert-original`, extracted to
text with their heading sizes preserved.

Nothing here is written from memory of the syllabus. Headings, activity labels
and exercise names are copied as printed; `scripts/check-chapter-contents.mjs`
refuses any heading that does not appear in the extracted chapter text. Points,
meanings and overviews are close paraphrase of the chapter text.

`scripts/import-chapter-contents.ts` writes each chapter into
`chapters.contents` on the platform connection. The app chapter is matched by
subject and number; Hindi A is Kshitij-2 (1–12) then Kritika (13–15), Hindi B is
Sparsh (1–14) then Sanchayan (15–17).

## Shape

```jsonc
{
  "book": "jemh1",
  "bookTitle": "Mathematics",
  "class": 10,
  "chapters": [
    {
      "bookChapter": 6,              // chapter number in THIS book
      "title": "Triangles",          // as printed
      "pages": 26,
      "author": null,                // literature: the writer/poet as printed
      "form": null,                  // literature: "Story", "Poem", "Play", "Biography" ...
      "overview": "Two to four sentences on what the chapter teaches or tells.",
      "sections": [
        {
          "number": "6.2",           // as printed, or null where the book does not number
          "title": "Similar Figures",
          "points": ["What this section establishes, from the text."],
          "subsections": [{ "number": "6.2.1", "title": "...", "points": ["..."] }]
        }
      ],
      "keyTerms": [{ "term": "Similar figures", "meaning": "as the book defines it" }],
      "keyResults": [{ "label": "Theorem 6.1", "statement": "as the book states it" }],
      "activities": ["Activity 1"],
      "exercises": [{ "name": "EXERCISE 6.1", "questions": 3 }],
      "bookSummary": ["The chapter's own Summary / What you have learnt, point by point."],
      "notes": null,                 // anything unreadable or uncertain, said plainly
      "extractionGaps": []           // headings printed with a symbol the PDF text lost
                                     // ("… Irrationality of √2"); the checker then
                                     // matches their words only
      "imageHeadings": []            // headings printed as pictures (First Flight's
                                     // exercise headings), read off page images;
                                     // accepted without a text match
    }
  ]
}
```
