# outline.provider

Supplies the hierarchical outline of a document — the tree of classes, functions, and sections shown in the outline panel.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideOutline()` returning one provider                     |
| Consumed by | `consumeOutline(provider)` returning a `Disposable`           |
| Owner       | [`outline-view`](https://github.com/lumine-code/outline-view) |

Unlike `symbol.provider`, which returns a flat searchable list, this returns a **tree**. `outline-view` also consumes the symbol hub’s `symbol.registry` as a fallback and assembles its flat lists into an outline, so implement this one only when you have real nesting to express.

A language server reaches this through an `ide-client` adapter.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "outline.provider": {
      "versions": { "1.0.0": "provideOutline" }
    }
  }
}
```

## Contract

```ts
type OutlineProvider = {
  getOutline(editor: TextEditor): Promise<Outline | null> | Outline | null;
  grammarScopes?: string[];
  priority?: number;
};

type Outline = {
  outlineTrees: OutlineTree[];
};

type OutlineTree = {
  startPosition: Point | [number, number];
  endPosition?: Point | [number, number];
  plainText?: string;
  tokenizedText?: Array<{ kind: string; value: string }>;
  representativeName?: string;
  icon?: string;
  kind?: string;
  children?: OutlineTree[];
};
```

| Member               | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `getOutline(editor)` | Required. Return the tree, or `null` when you have nothing.       |
| `grammarScopes`      | Scope names you serve. May be a getter, and is read on every use. |
| `priority`           | Higher wins. Defaults to `0`.                                     |

A node needs a `startPosition` and something to display. The label is resolved in order: `tokenizedText` (rendered with syntax highlighting), then `plainText`, then `representativeName`. `endPosition` defaults to `startPosition`, which makes the node a point rather than a range.

Positions are point-compatible — `[row, column]` or a `Point`.

## Minimal example

```js
module.exports = {
  provideOutline() {
    return {
      grammarScopes: ["source.mylang"],
      priority: 1,
      async getOutline(editor) {
        const tree = await parse(editor.getText());
        const toNode = (node) => ({
          plainText: node.name,
          kind: node.kind,
          icon: node.kind,
          startPosition: [node.startRow, node.startColumn],
          endPosition: [node.endRow, node.endColumn],
          children: node.children?.map(toNode),
        });
        return { outlineTrees: tree.roots.map(toNode) };
      },
    };
  },
};
```

## Behavior

**Exactly one provider is used per editor** — the highest-priority one whose `grammarScopes` cover the grammar. There is no merging and no fallthrough, so a provider that claims a grammar and then returns `null` leaves the panel empty rather than deferring to the next.

`grammarScopes` may be a getter whose value changes over time — a hub provider's set grows as language server sessions start — so it is re-read on every selection rather than snapshotted.

`getOutline` is called when the panel refreshes, which follows the active editor and its changes. It should be cheap enough to run after an edit settles.

Supply `endPosition` when you can: it is what lets the panel highlight the node covering the cursor rather than only exact starts.

## Teardown

`consumeOutline` returns a `Disposable` that removes the provider. Return it from your consumer method.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
