const { CompositeDisposable, Disposable } = require("lumine");
const OutlineView = require("./outline-view");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

class OutlineViewPackage {
  provideBackgroundTips() {
    return {
      packageName: "outline-view",
      tips: [
        "You can browse the symbols of the current file as a tree with {{ 'outline-view:toggle-focus' | keystroke }}",
      ],
    };
  }

  constructor() {
    this.registry = null;
    this.outlineView = null;
    this.subscriptions = null;
    this.owner = this.createOwner();
  }

  createOwner() {
    return { retired: false, connections: new Map(), subscriptions: new CompositeDisposable() };
  }

  initialize() {
    this.owner ??= this.createOwner();
  }

  activate() {
    const owner = (this.owner ??= this.createOwner());
    const owns = () => this.owner === owner && !owner.retired;
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "outline-view:show": () => owns() && this.getOutlineView()?.show(),
        "outline-view:toggle": () => owns() && this.getOutlineView()?.toggle(),
        "outline-view:toggle-focus": () => owns() && this.getOutlineView()?.toggleFocus(),
        // Reveal reads the active editor rather than the dispatch target, so
        // the editor scope only made the menu item dead off-editor. This
        // mirrors tree-view:reveal-active-file, which is workspace-scoped.
        "outline-view:reveal-in-outline-view": {
          description: "Expand the outline to the symbol holding the cursor.",
          didDispatch: () => {
            if (!owns()) return;
            const editor = lumine.workspace.getActiveTextEditor();
            if (!editor) return;
            this.getOutlineView()?.revealInOutlineView(editor);
          },
        },
      }),
    );
  }

  async deactivate() {
    const owner = this.owner;
    if (!owner) return;
    const subscriptions = this.subscriptions;
    const view = this.outlineView;
    owner.retired = true;
    this.owner = null;
    this.subscriptions = null;
    this.outlineView = null;
    this.registry = null;
    owner.connections.clear();
    view?.retire();
    owner.subscriptions.dispose();
    subscriptions?.dispose();
    if (view) {
      const pane = lumine.workspace.paneForItem(view);
      if (pane) {
        view.closingPane = pane;
        await pane.destroyItem(view);
        if (view.destroyed) await view.destroy();
      } else {
        await view.destroy();
      }
    }
  }

  consumeSymbolRegistry(registry) {
    const owner = this.owner;
    if (!owner || owner.retired) return new Disposable();
    const token = {};
    owner.connections.set(token, registry);
    const registration = new Disposable(() => {
      owner.subscriptions.remove(registration);
      if (!owner.connections.delete(token) || this.owner !== owner || owner.retired) return;
      this.refreshRegistry(owner);
    });
    owner.subscriptions.add(registration);
    this.refreshRegistry(owner);
    return registration;
  }

  refreshRegistry(owner) {
    if (this.owner !== owner || owner.retired) return;
    let registry = null;
    for (const value of owner.connections.values()) registry = value;
    if (this.registry === registry) return;
    this.registry = registry;
    this.outlineView?.setRegistry(registry);
  }

  getOutlineView() {
    const owner = this.owner;
    if (!owner || owner.retired) return null;
    if (this.outlineView === null) {
      const view = new OutlineView(this.registry);
      if (this.owner !== owner || owner.retired) {
        void view.destroy().catch(() => {});
        return null;
      }
      this.outlineView = view;
      view.onDidDestroy(() => {
        if (this.outlineView === view) this.outlineView = null;
      });
    }
    return this.outlineView;
  }

  deserializeOutlineView() {
    return this.getOutlineView();
  }
}

module.exports = new OutlineViewPackage();
