const { CompositeDisposable, Disposable } = require("lumine");
let OutlineView;

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
        // Reveal may be invoked from another surface in the same window,
        // using the document captured when its command menu was opened.
        "outline-view:reveal-in-outline-view": {
          description: "Expand the outline to the symbol holding the cursor.",
          isAvailable: (event) => Boolean(this.commandEditor(event)),
          didDispatch: (event) => {
            if (!owns()) return;
            const editor = this.commandEditor(event);
            if (!editor) return;
            return this.getOutlineView()?.revealInOutlineView(editor);
          },
        },
      }),
    );
  }

  commandEditor(event) {
    if (event?.context) return event.context.embeddedEditor ?? event.context.editor ?? null;
    return lumine.workspace.getActiveTextEditor();
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
      if (!OutlineView) {
        require("@lumine-code/etch").setScheduler(lumine.views);
        OutlineView = require("./outline-view");
      }
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
