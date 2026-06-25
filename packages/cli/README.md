# emviz

Interactive visualizer for Event Modeling YAML projects.

```sh
npx emviz
npx emviz .
npx emviz sync .
pnpm dlx emviz
```

`emviz` starts a local Vite server for exploring an Event Modeling project. In project mode, it creates `.event-modeling/graph.json` automatically when missing. Run `emviz sync` to explicitly create or update `.event-modeling/graph.json`.
