const { CompositeDisposable, Disposable } = require("atom");
const ProviderBroker = require("./provider-broker");
const OutlineView = require("./outline-view");

class OutlineViewPackage {
  constructor() {
    this.broker = new ProviderBroker();
    this.outlineView = null;
    this.subscriptions = null;
  }

  activate() {
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "outline-view:show": () => this.getOutlineView().show(),
        "outline-view:toggle": () => this.getOutlineView().toggle(),
      }),
      atom.commands.add("atom-text-editor", {
        "outline-view:reveal-in-outline-view": () => {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) return;
          this.getOutlineView().revealInOutlineView(editor);
        },
      }),
    );
  }

  deactivate() {
    this.subscriptions?.dispose();
    this.subscriptions = null;
    const view = this.outlineView;
    if (view) {
      const pane = atom.workspace.paneForItem(view);
      if (pane) {
        pane.destroyItem(view);
      } else {
        view.destroy();
      }
    }
  }

  consumeOutline(provider) {
    this.broker.addProviders(provider);
    return new Disposable(() => this.broker.removeProviders(provider));
  }

  consumeSymbolRegistry(registry) {
    this.broker.setSymbolRegistry(registry);
    return new Disposable(() => this.broker.clearSymbolRegistry());
  }

  getOutlineView() {
    if (this.outlineView === null) {
      this.outlineView = new OutlineView(this.broker);
      this.outlineView.onDidDestroy(() => {
        this.outlineView = null;
      });
    }
    return this.outlineView;
  }
}

module.exports = new OutlineViewPackage();
