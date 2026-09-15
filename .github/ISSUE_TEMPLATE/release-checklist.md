---
name: Release checklist
about: Track an emviz npm release
title: "Release emviz X.Y.Z"
labels: release
assignees: ""
---

## Release Checklist

- [ ] `pnpm release:patch`, `pnpm release:minor`, or `pnpm release:major` completed
- [ ] npm trusted publisher and package policy permit direct publishing
- [ ] Release commit and package contents reviewed
- [ ] `main` and release tag pushed manually
- [ ] GitHub Release published for the existing tag
- [ ] GitHub Actions published the package
- [ ] `npm view emviz version` returns expected version
- [ ] `npx emviz --help` works
