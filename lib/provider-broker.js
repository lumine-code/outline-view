const { Emitter } = require("lumine");
const SymbolRegistryAdapter = require("./symbol-registry-adapter");

// Keeps the registered outline providers and picks the best one for a given
// editor. The symbol hub (the `symbol.registry` service) is adapted into a
// single fallback outline provider.
class ProviderBroker {
  constructor() {
    this.providers = [];
    this.emitter = new Emitter();
    this.symbolRegistryAdapter = null;
    this.symbolRegistrySubscription = null;
  }

  addProviders(...providers) {
    this.providers.push(...providers);
  }

  removeProviders(...providers) {
    for (const provider of providers) {
      this.removeProvider(provider);
    }
  }

  setSymbolRegistry(registry) {
    this.clearSymbolRegistry();
    this.symbolRegistryAdapter = new SymbolRegistryAdapter(registry);
    this.addProviders(this.symbolRegistryAdapter);
    // Re-emitted on the broker's own emitter: the view subscribes to the
    // broker at construction, whether or not the service has connected yet.
    this.symbolRegistrySubscription = registry.onDidInvalidateFileSymbols((bundle) => {
      this.emitter.emit("did-invalidate-symbols", bundle);
    });
  }

  clearSymbolRegistry() {
    if (!this.symbolRegistryAdapter) return;
    this.removeProvider(this.symbolRegistryAdapter);
    this.symbolRegistrySubscription?.dispose();
    this.symbolRegistrySubscription = null;
    this.symbolRegistryAdapter = null;
  }

  onDidInvalidateSymbols(callback) {
    return this.emitter.on("did-invalidate-symbols", callback);
  }

  removeProvider(provider) {
    const index = this.providers.indexOf(provider);
    if (index > -1) {
      this.providers.splice(index, 1);
    }
  }

  chooseProviderForEditor(editor) {
    const baseScope = editor.getGrammar()?.scopeName;
    if (!baseScope) return null;

    let winner = null;
    for (const provider of this.providers) {
      // `grammarScopes` may be a getter whose value changes over time, so
      // re-read it on every pass instead of caching it at registration.
      const scopes = provider.grammarScopes ?? [];
      if (!scopes.includes(baseScope) && !scopes.includes("*")) continue;
      if (!winner || (winner.priority ?? 0) < (provider.priority ?? 0)) {
        winner = provider;
      }
    }
    return winner;
  }
}

module.exports = ProviderBroker;
