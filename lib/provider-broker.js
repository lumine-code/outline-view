const SymbolProviderWrapper = require("./symbol-provider-wrapper");

// Keeps the registered outline providers and picks the best one for a given
// editor. Symbol providers (the `symbol.provider` service) are funneled into a
// single wrapper that adapts them to the outline-provider contract.
class ProviderBroker {
  constructor() {
    this.providers = [];
    this.symbolProviderWrapper = new SymbolProviderWrapper();
  }

  addProviders(...providers) {
    this.providers.push(...providers);
  }

  removeProviders(...providers) {
    for (const provider of providers) {
      this.removeProvider(provider);
    }
  }

  addSymbolProviders(...providers) {
    this.symbolProviderWrapper.addSymbolProvider(...providers);
    if (!this.providers.includes(this.symbolProviderWrapper)) {
      this.addProviders(this.symbolProviderWrapper);
    }
  }

  removeSymbolProviders(...providers) {
    this.symbolProviderWrapper.removeSymbolProvider(...providers);
    if (this.symbolProviderWrapper.providers.length === 0) {
      this.removeProvider(this.symbolProviderWrapper);
    }
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
