---
name: Release checklist
about: Track an emviz npm release
title: "Release emviz X.Y.Z"
labels: release
assignees: ""
---

## Release Checklist

- [ ] `pnpm release:patch`, `pnpm release:minor`, or `pnpm release:major` completed
- [ ] GitHub Actions staged the package
- [ ] npm staged package reviewed with `npm stage view <stage-id>`
- [ ] npm staged tarball inspected with `npm stage download <stage-id>`
- [ ] npm staged package approved with `npm stage approve <stage-id>`
- [ ] `npm view emviz version` returns expected version
- [ ] `npx emviz --help` works
