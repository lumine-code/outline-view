const { Point, Range } = require("lumine");

// Symbol tags that map cleanly onto outline `kind` values (LSP SymbolKind
// names). Other tags are still shown, but only as icons.
const LSP_KINDS = new Set([
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
]);

// Like a Map, but each key holds a list of values.
class Index extends Map {
  add(key, ...values) {
    let list = this.get(key);
    if (!list) {
      list = [];
      this.set(key, list);
    }
    list.push(...values);
  }
}

// Adapts the symbol hub's `symbol.registry` service into an outline provider.
// Designed to be chosen only when a more suitable outline provider is not
// available. Provider selection, scoring, timeouts, and caching all live in
// the hub; this adapter only assembles the flat symbol list into a tree.
class SymbolRegistryAdapter {
  constructor(registry) {
    this.name = "Symbol Registry";
    this.priority = 0.8;
    this.grammarScopes = ["*"];
    this.registry = registry;
    // The view refreshes this provider on the registry's invalidation events
    // rather than on its own editor listeners.
    this.refreshViaRegistry = true;
  }

  // Asks the hub for the editor's symbols — served from its per-editor cache
  // when warm — and assembles them into an outline. `null` means the run was
  // superseded or no provider could serve it; the view keeps what it has.
  async getOutline(editor) {
    const symbols = await this.registry.getFileSymbols(editor);
    if (!symbols) return null;
    return this.assembleOutline(symbols);
  }

  // The result is typically a flat list, but the `context` field is used to
  // infer one level of hierarchy. The hub already normalized every symbol to
  // carry a `position` and sorted the list into document order.
  assembleOutline(symbols) {
    const results = [];
    const index = new Index();

    for (const symbol of symbols) {
      const name = symbol.shortName ?? symbol.name;
      let range;
      if (symbol.range) {
        range = Range.fromObject(symbol.range);
      } else {
        const position = Point.fromObject(symbol.position);
        range = new Range(position, position);
      }
      let icon = symbol.icon;
      if (!icon && symbol.tag) {
        icon = `type-${symbol.tag}`;
      }
      const tree = {
        icon,
        kind: LSP_KINDS.has(symbol.tag ?? "") ? symbol.tag : undefined,
        plainText: name,
        representativeName: name,
        startPosition: range.start,
        endPosition: range.end,
        children: [],
      };
      if (symbol.context) {
        // Attach to the most recent symbol whose name matches the context.
        const entries = index.get(symbol.context);
        const parent = entries ? entries[entries.length - 1] : null;
        if (parent) {
          parent.children.push(tree);
        } else {
          results.push(tree);
        }
      } else {
        results.push(tree);
      }
      index.add(name, tree);
    }

    return { outlineTrees: results };
  }
}

module.exports = SymbolRegistryAdapter;
