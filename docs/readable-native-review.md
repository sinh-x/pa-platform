# Readable native package review (PAP-273)

The Pi foreground capture presents short, ordinary-language pages (nine body
lines, wrapped to 72 columns), followed by a separate decision question. All
finite scope must be traversed before approval is offered: ticket/repository,
route, branch/base/feature, exact document versions/references/digests,
requirements/acceptance IDs, files/directories/new paths, matrix-bound check IDs,
permissions/exclusions and pinned run/subject/workflow/config bindings.

No scope is silently truncated. Oversized packages fail closed. Exact JSON is
available through **View exact technical bindings**, but is not the primary
question. Control/bidi characters are rendered visibly. Cancelling any page
cancels capture, without permissions. Nonforeground modes still cannot capture.
Authentication is checked before and after the dialogs, and the service retains
its evidence and revision checks. A v2 native capture digest binds the exact
request, presentation and selected responses; historical v1 records are retained.

These dialogs are not test/UAT completion and do not publish documents or launch
builders. Source fixtures verify the presentation contract; actual terminal
readability/accessibility still needs operator UAT on the installed candidate.
