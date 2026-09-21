/**
 * The English catalog — and the definition of what a catalog IS.
 *
 * This file is the source of truth in a stronger sense than the others: the
 * `MessageKey` union and the shape of every entry are derived from it with
 * `typeof`, so `hi-IN.ts` cannot compile unless it carries exactly these keys
 * with exactly these shapes. Adding a string here is what makes the Hindi
 * catalog fail to build, which is the point — a translation gap should stop a
 * deploy, not appear as a blank on a student's phone.
 *
 * ---------------------------------------------------------------------------
 * Flat dotted keys, not nested objects
 * ---------------------------------------------------------------------------
 * `"signin.code.label"` rather than `signin.code.label`. Nesting reads nicer
 * and is worse in the two ways that matter here: `keyof` stops being the whole
 * contract (you would need a recursive mapped type to assert parity between
 * catalogs), and a translator who omits a whole sub-object gets a type error
 * pointing at the object rather than at the four strings they missed.
 *
 * ---------------------------------------------------------------------------
 * What is NOT in here, and never will be
 * ---------------------------------------------------------------------------
 * Curriculum content. Questions, options, learning-outcome statements, concept
 * and chapter names are authored by teachers in English and are stored as
 * English rows in the curriculum plane, which carries no locale column and is
 * shared across every tenant. A student who switches to Hindi gets a Hindi
 * INTERFACE and English QUESTIONS. That is the honest state of the product;
 * translating a question is an authoring problem — somebody who teaches the
 * subject has to write the Hindi version and it has to be approved like any
 * other question — and no amount of interface plumbing turns into it.
 *
 * The brand name is not in here either. "Sahayak" is a wordmark, not a string:
 * it is the same word on the sign-in screen, the invoice and the app icon, and
 * a wordmark that changes with a setting is two brands.
 */

/**
 * Message values are either a plain string or a set of plural forms keyed by
 * CLDR category. `{name}` is a placeholder; see `translate.ts`.
 */
export const en = {
  // -- The page shell ------------------------------------------------------
  "signin.student.pageTitle": "Student sign in",
  "signin.title": "Sign in",
  "signin.description":
    "Enter the phone number your teacher added you with. We will send a code to it.",
  "signin.teacherPrompt": "Are you a teacher?",
  "signin.teacherLink": "Sign in here",
  "signin.aside.headline":
    "Your tests, in one place, with the time you have left always on screen.",
  "signin.aside.subtitle": "Class 9 and 10.",

  // -- Signing in with a printed card --------------------------------------
  "signin.card.prompt": "Have a sign-in card from your teacher?",
  "signin.card.link": "Use your card",
  "signin.card.pageTitle": "Sign in with your card",
  "signin.card.description":
    "Type the code printed on your card, or scan its QR code with a phone camera.",
  "signin.card.label": "Card code",
  "signin.card.hint": "Twelve letters and numbers. The dashes are optional.",
  "signin.card.checking": "Signing you in with your card…",
  /**
   * Plural, because the count is real — `CARD_SESSION_MS` in
   * `core/identity/login-cards.ts` — and a literal "12" here would be the
   * sentence that goes stale first.
   */
  "signin.card.sharedDevice": {
    one: "On a shared computer, sign out when you finish. A card sign-in also ends by itself after {count} hour.",
    other: "On a shared computer, sign out when you finish. A card sign-in also ends by itself after {count} hours.",
  },
  "signin.card.usePhone": "Sign in with a phone number instead",

  // -- Step one: the number ------------------------------------------------
  "signin.phone.label": "Phone number",
  "signin.phone.placeholder": "10-digit mobile number",
  "signin.phone.submit": "Send code",
  "signin.phone.submitting": "Sending…",

  // -- Step two: the code --------------------------------------------------
  "signin.code.label": "6-digit code",
  /**
   * A plural message. The count is real — `CODE_TTL_MS` in
   * `core/identity/student-auth.ts` — and the two English forms genuinely
   * differ, which is what a `count === 1` check would have got right by luck
   * and Hindi would have got wrong. See `translate.ts`.
   */
  "signin.code.validFor": {
    one: "This code works for {count} minute.",
    other: "This code works for {count} minutes.",
  },
  "signin.code.submit": "Sign in",
  "signin.code.submitting": "Checking…",
  /**
   * These two are followed on screen by the number in bold and a "change"
   * link, so they end where the number begins. English puts the preposition
   * last and needs no punctuation; Hindi puts the number first and ends with a
   * colon. Two independent sentences, not one sentence with a swapped noun —
   * which is the whole reason a catalog holds sentences rather than words.
   */
  "signin.code.sentTo": "If this number is registered, a code is on its way to",
  "signin.code.createdFor": "Code created for",
  "signin.code.change": "Change",

  // -- When the SMS gateway refused the message ----------------------------
  "signin.undelivered.title": "We could not send the message",
  "signin.undelivered.body":
    "The code was created, but our text-message service did not accept it. Ask your teacher to sign you in, or try again in a few minutes.",

  /**
   * Interpolated, and it has to be: English puts the code before "is", Hindi
   * puts it before "है" at the end of the clause. Building this sentence as
   * prefix + <strong>{code}</strong> + suffix would hard-code English word
   * order into the markup, and the Hindi version would read backwards with no
   * way for a translator to fix it.
   */
  "signin.dev.notice":
    "Development only — your code is {code}. This never appears in production.",
  "signin.dev.unregistered":
    "Development only — no student is registered with this number, so no code will sign in with it. Use a number from a class roster. This never appears in production.",

  // -- Failures ------------------------------------------------------------
  "error.sendCode": "We could not send a code just now. Please try again.",
  "error.network":
    "We could not reach the server. Check your connection and try again.",
  "error.badCode": "That code did not work.",

  // -- The student bar -----------------------------------------------------
  //
  // The bar and the home dashboard are the first signed-in surfaces through
  // the seam. Everything the product WRITES about a student — the plan's
  // sentences, a paper's window, readiness lines — is still assembled in
  // English in core/, and paper titles, concept names and questions are
  // curriculum content that no catalog touches.
  "student.skip": "Skip to main content",
  "student.nav.practice": "Practice",
  "student.nav.progress": "Progress",
  "student.nav.syllabus": "Syllabus",
  "student.signOut": "Sign out",
  "student.language.label": "Language",
  "student.language.hint": "Questions stay in English.",
  "student.language.failed": "We could not change the language. Try again.",

  // -- Home: the header and the tests --------------------------------------
  "home.hello": "Hello, {name}",
  "home.intro.live": "Here is what your teacher has set.",
  "home.intro.none":
    "Nothing is set for you right now. This page will fill up when your teacher assigns a test.",
  "home.sectionFailed": "We couldn't load this right now. Refresh the page to try again.",
  "home.tests.heading": "Tests to take",
  "home.tests.emptyTitle": "No tests yet",
  "home.tests.emptyBody":
    "When your teacher assigns a test to your class, it appears here with the time you have to finish it. If your teacher gave you a class code, use it above.",
  "home.tests.noneOpen":
    "Nothing is open for you right now. A new test appears here with the time you have to finish it.",
  "home.test.open": "Open now",
  "home.test.scheduled": "Scheduled",
  "home.test.closed": "Closed",
  "home.test.cancelled": "Cancelled",
  "home.test.questions": "Questions",
  "home.test.marks": "Marks",
  "home.test.time": "Time",
  "home.test.minutes": { one: "{count} min", other: "{count} min" },
  "home.test.attempts": "Attempts",
  "home.test.attemptsOf": "{used} of {max}",
  "home.test.seeResult": "See result",
  "home.test.onPaper":
    "Sat on paper in class. Your teacher records your answers, and the result appears here.",
  "home.test.notTaken": "You did not take this one.",
  "home.test.notReleased": "Your teacher has not released the result yet.",
  "home.finished.heading": "Finished",

  // -- Home: latest result -------------------------------------------------
  "home.result.heading": "Latest result",
  "home.result.emptyTitle": "No results yet",
  "home.result.emptyBody":
    "When your teacher releases the result of a test you sat, your marks appear here.",
  "home.result.marksLabel": "Marks",
  "home.result.soFar": "marked so far",
  "home.result.unmarked": "Not marked yet",
  "home.result.pending": {
    one: "{count} mark is still with your teacher",
    other: "{count} marks are still with your teacher",
  },
  "home.result.toReview": {
    one: "{count} question to look at again",
    other: "{count} questions to look at again",
  },
  "home.result.fullMarks": "Full marks on every question.",
  "home.result.answersLater": "The answers open once everyone has finished the paper.",
  "home.result.seeAnswers": "See the answers",
  "home.result.seeResult": "See the result",
  "home.result.thingsToFix": "Things to fix",

  // -- Home: up next -------------------------------------------------------
  "home.plan.heading": "Up next",
  "home.plan.whole": {
    one: "See the whole plan",
    other: "See the whole plan — {count} things, in order",
  },

  // -- Home: my concepts ---------------------------------------------------
  "home.concepts.heading": "My concepts",
  "home.concepts.secure": "Secure",
  "home.concepts.almost": "Almost there",
  "home.concepts.practice": "Needs practice",
  "home.concepts.unknown": "Not enough evidence yet",
  "home.concepts.startWith": "Weakest so far:",
  "home.concepts.practise": "Practise it",
  "home.concepts.allSecure": "Everything measured here is secure.",
  "home.concepts.noneMeasured": "Nothing measured in this subject yet.",
  "home.concepts.emptyTitle": "Nothing measured yet",
  "home.concepts.emptyBody":
    "Sit a test and this shows how you are doing on each idea, subject by subject.",
  "home.concepts.all": "See my progress",

  // -- Home: things to fix -------------------------------------------------
  "home.fix.heading": "Things to fix",
  "home.fix.open": {
    one: "{count} question to fix",
    other: "{count} questions to fix",
  },
  "home.fix.resolved": {
    one: "{count} fixed in the last 7 days",
    other: "{count} fixed in the last 7 days",
  },
  "home.fix.emptyTitle": "Nothing to fix",
  "home.fix.emptyBody":
    "A question you get wrong in a test lands here, so you can come back to it.",
  "home.fix.link": "Open the list",

  // -- Home: teacher feedback ----------------------------------------------
  "home.feedback.heading": "Teacher feedback",
  "home.feedback.new": "New feedback on {title}",
  "home.feedback.locked":
    "Your teacher has left feedback. You can read it when the answers open, once everyone has finished the paper.",
  "home.feedback.more": {
    one: "And {count} more paper with new feedback.",
    other: "And {count} more papers with new feedback.",
  },
  "home.feedback.read": "Read it",
  "home.feedback.emptyTitle": "No new feedback",
  "home.feedback.emptyBody":
    "When your teacher writes a comment on one of your answers, it shows up here.",

  // -- Home: announcements -------------------------------------------------
  "home.announcements.heading": "From your teachers",
  "home.announcements.truncated": "Showing the latest {count}.",
  "home.announcements.emptyTitle": "No announcements",
  "home.announcements.emptyBody":
    "Messages your teacher sends to your class in the last 30 days appear here.",

  // -- Home: this week's effort --------------------------------------------
  "home.effort.heading": "Your effort",
  "home.effort.window": {
    one: "In the last {count} day",
    other: "In the last {count} days",
  },
  "home.effort.sets": "Practice sets finished",
  "home.effort.answered": "Practice questions answered",
  "home.effort.fixed": "Mistakes fixed",
  "home.effort.emptyBody":
    "Nothing yet in the last 7 days. Finished practice sets and fixed questions count here.",
  "home.effort.start": "Start practising",

  // -- Home: saved questions -----------------------------------------------
  "home.saved.heading": "Saved questions",
  "home.saved.count": { one: "{count} saved", other: "{count} saved" },
  "home.saved.all": "See all saved",
  "home.saved.emptyTitle": "Nothing saved",
  "home.saved.emptyBody": "Save a question from a result to come back to it later.",

  // -- Home: exam readiness ------------------------------------------------
  "home.readiness.heading": "Exam readiness",
  "home.readiness.tested": "Tested on {tested} of {total} chapters across your subjects",
  "home.readiness.open": "See the full picture",
  "home.readiness.emptyTitle": "No syllabus yet",
  "home.readiness.emptyBody":
    "Once you are in a class, this shows how much of the syllabus your tests have covered.",

  // -- Home: who can see my progress ---------------------------------------
  "home.viewers.heading": "Who can see my progress",
  "home.viewers.none": "No one else can see your progress except your teachers.",
  "home.viewers.active": "Can see your marks and progress",
  "home.viewers.invited": "Invited. Cannot see anything unless they accept.",
  "home.viewers.scope":
    "Your teachers can see your work. A parent never sees your written answers, your list of things to fix or what you asked for help with.",
  "relationship.MOTHER": "Mother",
  "relationship.FATHER": "Father",
  "relationship.GUARDIAN": "Guardian",
} as const;
