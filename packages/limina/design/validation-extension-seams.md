# Validation Extension Seams

The extension seam is the typed pair `ValidationInputKind -> ValidationView`, followed by a validator that can only read its view and call `context.report()`.

The 0.2 registry stores only the rule descriptor and typed validate function. It does not store providers, caches, stage dependencies, execution order, or other rule results. Enabled registrations are grouped by the closed internal input kind; fixed stage factories prepare only required data.

The internal nine-kind union is not a future public export list. Architecture, package-output, and release suites share issue assembly but retain separate registries, workflows, failure policies, and exposure decisions.
