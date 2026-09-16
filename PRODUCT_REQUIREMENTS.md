# Product Requirements

## 1. Positioning

**Not:** "AI Mock Test App."

**This:** *AI Assessment & Personalised Learning Platform for Class 9 & 10.*

> Assess → identify learning gaps → personalise practice → improve performance.

| Audience | The promise |
|---|---|
| Teacher | Create assessments faster, and know exactly where your students need help. |
| Student | Know what you don't know, and practise exactly that. |
| Parent | Understand your child's progress, and know where attention is needed. |
| Institute | Manage assessments and performance across every batch. |

The mock test is the **assessment layer**. The product is what happens after a student
submits.

## 2. Why this wins, and where it loses

**Wins on:** the loop. Anyone can generate questions — the model does that. Almost
nobody closes the loop from a wrong answer to a measured improvement, because that
needs a curriculum-grounded concept model, an estimator that admits uncertainty, and a
teacher workflow that turns a diagnosis into a class that actually happens.

**Loses on:** content depth in year one (§9, Risk 1), brand trust against incumbents
with school relationships, and anything requiring proctoring rigour.

**Not competing on:** volume of questions, video lectures, live classes, or exam
prediction.

## 3. Personas

**Priya — teacher, 34, Class 10 Mathematics, tuition centre, 120 students.**
Spends 4–6 hours a week writing tests and 3 more marking them. Knows roughly who is
weak; cannot prove it, and cannot remember it in March. Uses WhatsApp for everything.
Will abandon any tool that takes more than one evening to learn.
*Wins when:* a test that took 90 minutes takes 15, and the analysis is something she
did not have at all.

**Arun — student, 15, Class 10, CBSE.**
Studies on a shared Android phone, often after 9pm, often on patchy data. Knows his
Maths marks; does not know that his Maths problem is specifically similar triangles.
*Wins when:* a result tells him what to do next in one sentence and one button.

**Meena — parent, 41, small-business owner.**
Wants to know whether her son is on track and what to do about it. Does not know what
"mastery" or "learning outcome" means and should not have to.
*Wins when:* one screen, plain language, one recommendation.

**Rajesh — institute owner, 12 teachers, 400 students.**
Buys. Wants to know which batches and which teachers are performing, and wants
something to show parents at fee time.
*Wins when:* he can compare batches and hand a parent a report.

## 4. Jobs to be done

| Persona | Job | Today | Success |
|---|---|---|---|
| Teacher | Produce a syllabus-aligned test | 90 min of typing and copying | < 15 min, better coverage |
| Teacher | Know who needs help, and on what | Intuition | Named concepts, named students, evidence attached |
| Teacher | Act on that | A generic revision class | A targeted test in one click, measured after |
| Student | Understand a wrong answer | Ask a friend, or skip it | Explanation plus targeted practice |
| Student | Know what to study tonight | Guesswork | One ranked recommendation |
| Parent | Know if their child is on track | The report card, twice a year | Continuous, plain-language |
| Institute | Compare batches | Manual spreadsheets | A dashboard with exceptions surfaced |

## 5. Functional requirements

Priority: **P0** MVP · **P1** Phase 2 · **P2** Phase 3.

### Teacher
| | Requirement | P |
|---|---|---|
| T1 | Sign up, create an organization | P0 |
| T2 | Create classes; add students by paste, CSV or join code | P0 |
| T3 | Write questions manually, all objective types | P0 |
| T4 | Browse the question bank (global + org + private) with filters | P0 |
| T5 | Generate questions with AI against a curriculum scope | P0 |
| T6 | Review, edit, regenerate, approve or reject every generated item | P0 |
| T7 | Build an assessment via blueprint | P0 |
| T8 | Publish and assign with a window and settings | P0 |
| T9 | See results: distribution, per-question, per-student | P0 |
| T10 | Release results to students | P0 |
| T11 | Chapter and concept mastery per class | P0 |
| T12 | Learning Gaps screen, prioritised, with actions | P1 |
| T13 | Create a remedial test from a gap in one click | P1 |
| T14 | Grade subjective answers with a rubric | P1 |
| T15 | AI Copilot | P1 |
| T16 | Parent reports | P1 |
| T17 | Live test monitoring | P2 |
| T18 | Lesson planning from gaps | P2 |

### Student
| | Requirement | P |
|---|---|---|
| S1 | Sign in by phone OTP or class code | P0 |
| S2 | See assigned tests with windows | P0 |
| S3 | Take a test: timer, navigation, mark for review, autosave | P0 |
| S4 | Survive refresh, network loss and backgrounding without losing work | P0 |
| S5 | Submit and see a score | P0 |
| S6 | Review answers with explanations after release | P0 |
| S7 | See progress over time | P0 |
| S8 | See weak concepts with a next action | P1 |
| S9 | Personalised practice | P1 |
| S10 | Mistake Bank | P1 |
| S11 | AI tutor: hint, steps, simpler explanation | P2 |
| S12 | Study plan | P2 |

### Parent
| | Requirement | P |
|---|---|---|
| P1 | Accept a link invitation, verify by OTP | P1 |
| P2 | Overall performance in plain language | P1 |
| P3 | Strengths and areas needing attention | P1 |
| P4 | Improvement over time | P1 |
| P5 | Weekly recommendations | P1 |
| P6 | Downloadable term report | P1 |

### Institute
| | Requirement | P |
|---|---|---|
| I1 | Invite and manage teachers | P1 |
| I2 | Bulk student import and transfers | P1 |
| I3 | KPI dashboard | P1 |
| I4 | Batch comparison | P1 |
| I5 | Teacher activity and outcomes | P1 |
| I6 | Subscription and usage | P1 |
| I7 | Institute reports | P1 |

### Platform
| | Requirement | P |
|---|---|---|
| X1 | Curriculum management | P0 |
| X2 | Global question bank curation | P0 |
| X3 | Tenant administration | P0 |
| X4 | AI cost and model configuration | P0 |
| X5 | Audit log search | P0 |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Submit p95 < 400ms; dashboard < 1.5s; test player < 180KB gzipped |
| Reliability | 99.5% uptime; **zero tolerance for lost answers** |
| Offline | The test player works through a network loss and syncs on return |
| Devices | Mid-tier Android, Chrome, 360px width, 3G |
| Accessibility | WCAG 2.2 AA |
| Security | `SECURITY_MODEL.md` |
| Privacy | No student PII to any model; data resident in India |
| Scale | 50k students, 500 organizations, 200 concurrent submissions per test |

"Zero tolerance for lost answers" is the one requirement with no acceptable failure
rate. A lost answer is an academic harm to a specific child, and it is unrecoverable
after the fact.

## 7. Business model

Plans and entitlements in the database. **No price is hard-coded.**

| Plan | Who | Shape |
|---|---|---|
| Free | Trial teacher | 1 class, 30 students, 5 AI generations/month, basic analytics |
| Teacher Pro | Individual | 5 classes, 200 students, 100 generations/month, full analytics, parent reports |
| Institute | 5–50 teachers | Per student per month, admin console, batch analytics, priority support |
| School | 50+ | Custom, SSO, MIS integration, dedicated support |
| Student Premium | B2C | Practice, mistake bank, tutor — independent of a teacher |

Every gated capability is an `entitlements` row checked as
`can(org, 'ai_generations_per_month')`. Adding a plan is data, not a deploy.

Cost floor from `AI_ARCHITECTURE.md` §8: about **$0.13–0.17 per student per month** in
AI. At a target Institute price of ₹80–150 per student per month, AI is roughly 8–15%
of revenue — healthy, provided per-org budgets are enforced from the first release
rather than added after the first surprise.

## 8. Metrics

**North Star — measured improvement in concept mastery following an intervention.**

Not tests taken. Tests taken is a vanity metric that a school can inflate to nothing.
The number that matters:

```
  Concept mastery, before an intervention   48%
  → targeted practice / remedial test
  Concept mastery, after                    71%
```

Reported as *"gaps closed"* per class per month, with the baseline stamped at
intervention creation so the claim is falsifiable.

**Supporting:**

| Layer | Metrics |
|---|---|
| Activation | Teacher reaches first assigned test (target < 12 min, ≥ 60% of signups) |
| Teacher | Assessments created, AI generation approval rate (**≥ 70%**), estimated time saved, weekly active |
| Student | Attempt completion rate, practice completion, gaps resolved, week-4 retention |
| Institute | Active teachers, active students, assessments per teacher, renewal |
| Business | MRR, conversion, churn, ARPU, AI cost per customer, gross margin |

Generation approval rate is a **product-health metric, not an AI metric**. Below 70%,
the feature costs a teacher more than it saves and everything downstream is built on
sand.

## 9. Explicit non-goals

Written down so they are not re-argued monthly:

1. **Not a content library.** No video lectures, no textbook reader.
2. **Not a school ERP.** No fees, attendance, timetable or payroll.
3. **Not high-stakes proctoring.** Deterrence signals, honestly labelled (`SECURITY_MODEL.md` §3).
4. **Not a homework marketplace.**
5. **Not competitive-exam prep** (JEE/NEET) in year one. Different curriculum, different customer, different sales motion.
6. **Not multi-board** at launch. CBSE only; the schema supports more, the content does not.
7. **Not a chatbot with a database attached.** AI appears where it does specific work.

## 10. Decisions taken

| Question | Decision (2026-09-07) |
|---|---|
| Go-to-market | **Individual teachers and small tuition centres first.** Teacher screens lead; the institute console stays Phase 2. An institute upgrade is a plan change, not a migration, so this is reversible. |
| Seed the global question bank before launch? | **No — launch with an empty bank.** Teachers author and generate their own. See `RISKS.md` Risk 1 for what this costs and how it is mitigated. |
| Who reviews AI-generated questions? | **A hired freelance CBSE teacher**, reviewing inside the product's own review queue rather than in a spreadsheet. The best approved items are promoted to the global bank over time. |
| Build order | **Slice 0 first** — design system, auth, tenancy. |

Still open:

| Question | Decide by | Owner |
|---|---|---|
| Hindi-medium support — how soon? | After the first ten customers | Product |
| Subjective grading in Phase 2, or defer? | After measuring how many teachers ask | Product |
| Do parents pay, or are they a retention feature? | After the first institute renewal | Business |
