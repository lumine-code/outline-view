const { CompositeDisposable, Disposable } = require("lumine");
const ProviderBroker = require("./provider-broker");
const OutlineView = require("./outline-view");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

class OutlineViewPackage {
  constructor() {
    this.broker = new ProviderBroker();
    this.outlineView = null;
    this.subscriptions = null;
  }

  activate() {
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "outline-view:show": () => this.getOutlineView().show(),
        "outline-view:toggle": () => this.getOutlineView().toggle(),
        "outline-view:toggle-focus": () => this.getOutlineView().toggleFocus(),
        // Reveal reads the active editor rather than the dispatch target, so
        // the editor scope only made the menu item dead off-editor. This
        // mirrors tree-view:reveal-active-file, which is workspace-scoped.
        "outline-view:reveal-in-outline-view": () => {
          const editor = lumine.workspace.getActiveTextEditor();
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
      const pane = lumine.workspace.paneForItem(view);
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
