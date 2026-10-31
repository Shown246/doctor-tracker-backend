# Milestone 3 validation and handoff

Implemented locally on 2026-10-31 in `E:\Codes\doctor-tracker-backend`, on `main`. Implementation commit: `475156f` (`Add patient management, assignments and private clinical notes`). This validation record and the completed checklist are committed separately.

Environment: Windows, Node.js 24.18.0, npm 11.15.0, isolated MongoMemoryReplSet instances using MongoDB 8.2.6. Tests use synthetic records and never load `.env` or connect to Atlas. Dependencies and the lockfile are unchanged.

## Validation

| Command                     | Result                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run docs:openapi`      | Generated the OpenAPI 3.1 contract, version 0.3.0, with 21 paths; the generator now applies repository formatting. |
| `npm run lint`              | Passed with zero warnings.                                                                                         |
| `npm run format:check`      | Passed, including the milestone 3 checklist and generated contract.                                                |
| `npm run typecheck`         | Passed with strict TypeScript settings.                                                                            |
| `npm test`                  | All 156 tests passed in seven files; final full run took 89.91 seconds.                                            |
| `npm run build`             | Passed.                                                                                                            |
| `git diff --cached --check` | Passed before the implementation commit.                                                                           |

Hosted CI has not run. `git remote` returns no configured remotes; remote creation/pushing remains with the owner under the existing local-only Git instruction. The hosted CI checkbox stays open. No deployment or frontend work is included.

## Verified workflows

- Strict doctor creation/detail/edit/list APIs normalize unique emails, regenerate search keys, reject unsupported fields, and prevent linked-email changes. Lists combine search, specialization/hospital filters, stable name/date ordering and pagination. Patient counts use one grouped query for just the doctor page, including zero counts.
- Patient creation validates demographics, date of birth, optional unique email and supported status. Zero, one and multiple initial doctor assignments work, duplicate IDs are deduplicated, and missing doctors/forced association-write failures roll back creation.
- Admin patient edits whitelist demographics, contact and clinical fields. Clinical edits require the last-read revision, increment it and record the editor/time. Linked email cannot change or be removed; assignment injection is rejected. Details paginate safe linked-doctor summaries separately from note review.
- Admin and doctor patient lists apply combined filters, assignment scope and totals in the database. Multi-doctor patients count once in a patient list. Unassigned patients remain available to admins. Manipulated doctor filters intersect the authenticated/path scope. Generic list/detail/profile DTOs exclude notes, account internals and derived search keys.
- Clinical and note writes reject stale revisions. Concurrent doctors editing a shared patient revision have one success and one conflict. Concurrent note replacement/clearing also has one success and one conflict. Clearing a note retains/increments its revision and timestamp. Empty note state is explicit; admins review only nonempty notes with safe doctor attribution and pagination.
- The full create/link/clinical-edit/private-note/unlink/relink/delete workflow passes. Notes stay isolated between doctors, unlink deletes only that doctor's association/note, removed doctors immediately lose access, and relink starts with no previous note. Simultaneous links succeed with one association.
- Self-service uses session-linked profiles exclusively. Patients may change only phone/address, with no clinical revision change. Identity, email, condition, status, role and reference edits are rejected. Linked-doctor lists are paginated and omit private notes.
- Permanent deletion removes every association/note, disables the linked patient account and clears its profile reference. Existing patient and doctor sessions lose access. A forced final patient-removal failure rolls back earlier association deletion and account disablement.
- Deterministic race tests pause an authorized clinical/note write before its association save, commit unlinking, then resume the write and require `404`. Another pauses linking before its patient guard write, commits deletion, resumes linking and verifies no patient/association can be restored.
- A complete endpoint permission matrix exercises anonymous, pending, rejected, disabled, admin, doctor and patient sessions. Runtime response samples validate against the OpenAPI response schemas; a drift test compares the generated contract with its source.
- Prefix search escapes regex metacharacters and normalizes full fields/word tokens. Query tests reject malformed pages, limits, sorts, IDs and dates. Creation-date boundaries use IANA `Asia/Dhaka` rules, including historical offset transitions and a 25-hour calendar day. Stable ties and later/empty pages are covered.

## Transactions and performance observations

Related writes use explicit driver sessions with snapshot reads and majority writes. Retries reload documents rather than reusing mutated instances. Clinical writes force an association internal-version write before changing the patient, serializing against unlinking. Relationship writes force a patient internal-version write, serializing against deletion and approval. Note writes serialize on their association. Internal guards do not change the public clinical/note revision unless the corresponding clinical/note content is edited.

Lists return at most 100 records. Patient scope uses indexed association lookups with an existence limit rather than collecting every assignment ID into application memory. A facet applies the same scope to records and totals; sorting precedes the facet so the initial patient match/sort can use existing indexes. Linked-doctor and note-review queries fetch doctor projections only after pagination. Doctor counts group only the current page's IDs. Projections and explicit DTOs bound returned fields.

No large performance fixture, timing benchmark or `explain("executionStats")` measurement was run in milestone 3. Milestone 4 should measure combined prefix/exact filters, patient-first scope lookups for sparse doctor assignments, and count/facet costs. Reverse assignment-date and note-update sorts may benefit from additional patient-leading compound indexes after representative plans are measured. Current indexes are unchanged, so no Atlas index migration is needed for this milestone.

## Handoff

See [client usage](management-and-clinical.md), [OpenAPI](openapi.json) and the [milestone checklist](milestone-03-management-and-clinical-apis.md). Milestone 4 retains dashboards, filter metadata, interactive admin documentation, demo/performance fixtures, query-plan verification, hosting and contract release. The only external verification pending for milestone 3 is hosted CI after the owner publishes the repository.
