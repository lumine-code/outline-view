const { Point, Range } = require("atom");

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

function positionForSymbol(symbol) {
  if (symbol.position) return Point.fromObject(symbol.position);
  if (symbol.range) return Range.fromObject(symbol.range).start;
  return null;
}

function compareSymbols(a, b) {
  const positionA = positionForSymbol(a);
  const positionB = positionForSymbol(b);
  if (!positionB && !positionA) return 0;
  if (!positionB) return -1;
  if (!positionA) return 1;
  return positionA.compare(positionB);
}

// Consumes the `symbol.provider` service and adapts its providers into an
// outline provider. Designed to be chosen only when a more suitable outline
// provider is not available.
class SymbolProviderWrapper {
  constructor() {
    this.name = "Symbol Provider";
    this.priority = 0.8;
    this.grammarScopes = ["*"];
    this.providers = [];
    this.abortController = null;
  }

  addSymbolProvider(...providers) {
    for (const provider of providers) {
      if (this.providers.includes(provider)) continue;
      this.providers.push(provider);
    }
  }

  removeSymbolProvider(...providers) {
    for (const provider of providers) {
      const index = this.providers.indexOf(provider);
      if (index > -1) {
        this.providers.splice(index, 1);
      }
    }
  }

  getScoreBoost(name, packageName, preferredProviders) {
    if (packageName === "unknown") return 0;
    let index = preferredProviders.indexOf(packageName);
    if (index === -1) {
      index = preferredProviders.indexOf(name);
    }
    if (index === -1) return 0;
    return preferredProviders.length - index;
  }

  // If the `symbols-view` package is installed, honor the user's configured
  // ranking of symbol providers when picking the exclusive provider.
  async getSelectedProviders(meta) {
    const exclusivesByScore = [];
    const selectedProviders = [];
    const preferredProviders = atom.config.get("symbols-view.preferCertainProviders") ?? [];

    const answers = this.providers.map((provider) => provider.canProvideSymbols(meta));
    const outcomes = await Promise.allSettled(answers);

    for (const [index, provider] of this.providers.entries()) {
      const outcome = outcomes[index];
      if (outcome.status === "rejected") continue;
      let score = outcome.value;
      if (!score) continue;

      const name = provider.name ?? "unknown";
      const packageName = provider.packageName ?? "unknown";
      const isExclusive = provider.isExclusive ?? false;

      if (score === true) score = 1;
      score += this.getScoreBoost(name, packageName, preferredProviders);

      if (isExclusive) {
        // "Exclusive" providers are put aside until the end; only the one with
        // the highest score is used.
        exclusivesByScore.push({ provider, score });
      } else {
        // Non-exclusive providers all contribute symbols.
        selectedProviders.push(provider);
      }
    }

    if (exclusivesByScore.length > 0) {
      exclusivesByScore.sort((a, b) => b.score - a.score);
      selectedProviders.unshift(exclusivesByScore[0].provider);
    }

    return selectedProviders;
  }

  // Asks the symbol providers for symbols, then assembles them into an
  // outline. The result is typically a flat list, but the `context` field is
  // used to infer one level of hierarchy.
  async getOutline(editor) {
    this.abortController?.abort();
    this.abortController = new AbortController();

    const meta = {
      type: "file",
      editor,
      signal: this.abortController.signal,
    };

    const selectedProviders = await this.getSelectedProviders(meta);
    if (selectedProviders.length === 0) return null;

    const rawSymbols = [];
    const symbolPromises = selectedProviders.map((provider) => {
      return Promise.resolve(provider.getSymbols(meta)).then((symbols) => {
        if (symbols === null) return;
        rawSymbols.push(...symbols);
        // Re-sort whenever new symbols arrive; the outline should always be
        // in document order.
        rawSymbols.sort(compareSymbols);
      });
    });

    await Promise.allSettled(symbolPromises);

    const results = [];
    const index = new Index();

    for (const symbol of rawSymbols) {
      const name = symbol.shortName ?? symbol.name;
      let range;
      if (symbol.range) {
        range = Range.fromObject(symbol.range);
      } else if (symbol.position) {
        const position = Point.fromObject(symbol.position);
        range = new Range(position, position);
      } else {
        continue;
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

module.exports = SymbolProviderWrapper;
