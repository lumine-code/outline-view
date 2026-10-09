const { Emitter, Point, Range } = require("lumine");
describe("Outline service and pane lifetime audit", () => {
  let main, editor, view, leases, emitters, gates, work;
  function registry() {
    const emitter = new Emitter();
    emitters.push(emitter);
    const tree = [
      {
        name: "Owned outline",
        position: new Point(0, 0),
        range: new Range([0, 0], [1, 0]),
        children: [],
      },
    ];
    return {
      getFileSymbolTree: async () => tree,
      peekFileSymbolTree: () => tree,
      onDidInvalidateFileSymbols: (cb) => emitter.on("invalidate", cb),
      destroy: jasmine.createSpy("borrowed registry destroy"),
    };
  }
  function provide(value) {
    const lease = lumine.packages.serviceHub.provide("symbol.registry", "1.1.0", value);
    leases.push(lease);
    return lease;
  }
  function deferred() {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    gates.push(resolve);
    return { promise, resolve };
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    leases = [];
    emitters = [];
    gates = [];
    work = [];
    main = (await lumine.packages.activatePackage("outline-view")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("controlled\noutline");
    await new Promise((resolve) => lumine.views.updateDocument(resolve));
    view = null;
  });
  afterEach(async () => {
    for (const resolve of gates) resolve();
    await Promise.allSettled(work);
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("outline-view");
    if (view) {
      const pane = lumine.workspace.paneForItem(view);
      if (pane) await pane.destroyItem(view, true);
    }
    for (const emitter of emitters) emitter.dispose();
    editor.destroy();
    await new Promise((resolve) => lumine.views.updateDocument(resolve));
  });
  it("keeps the same borrowed registry until the last actual service edge ends", () => {
    const payload = registry(),
      first = provide(payload),
      second = provide(payload);
    view = main.getOutlineView();
    first.dispose();
    expect(main.registry).toBe(payload);
    expect(view.registry).toBe(payload);
    expect(payload.destroy).not.toHaveBeenCalled();
    second.dispose();
    expect(main.registry).toBeNull();
  });
  it("falls back to the newest remaining live registry after a distinct provider withdraws", () => {
    const older = registry(),
      newer = registry();
    provide(older);
    const second = provide(newer);
    view = main.getOutlineView();
    expect(view.registry).toBe(newer);
    second.dispose();
    expect(main.registry).toBe(older);
    expect(view.registry).toBe(older);
    expect(older.destroy).not.toHaveBeenCalled();
    expect(newer.destroy).not.toHaveBeenCalled();
  });
  it("does not reveal an old view while its real pane retirement is pending", async () => {
    view = main.getOutlineView();
    const gate = deferred(),
      arrived = deferred(),
      closeGate = deferred();
    const open = lumine.workspace.open.bind(lumine.workspace);
    spyOn(lumine.workspace, "open").and.callFake(async (item, options) => {
      const value = await open(item, options);
      if (item === view) {
        arrived.resolve();
        await gate.promise;
      }
      return value;
    });
    const opening = view.show();
    work.push(opening);
    await arrived.promise;
    const pane = lumine.workspace.paneForItem(view);
    const close = pane.onWillDestroyItem(({ item }) =>
      item === view ? closeGate.promise : undefined,
    );
    leases.push(close);
    const activate = spyOn(view, "activate").and.callThrough();
    const closing = main.deactivate();
    work.push(closing);
    expect(main.subscriptions).toBeNull();
    gate.resolve();
    await opening;
    expect(activate).not.toHaveBeenCalled();
    closeGate.resolve();
    await closing;
  });
  it("keeps the newer view when an old real pane close completes after replacement activation", async () => {
    view = main.getOutlineView();
    await view.show();
    const gate = deferred(),
      pane = lumine.workspace.paneForItem(view);
    leases.push(pane.onWillDestroyItem(({ item }) => (item === view ? gate.promise : undefined)));
    const closing = main.deactivate();
    work.push(closing);
    main.activate();
    const replacement = main.getOutlineView();
    expect(replacement).not.toBe(view);
    gate.resolve();
    await closing;
    expect(main.getOutlineView()).toBe(replacement);
  });
  it("removes only its owned item when actual Core placement completes after retirement", async () => {
    view = main.getOutlineView();
    const gate = deferred(),
      arrived = deferred();
    const open = lumine.workspace.open.bind(lumine.workspace);
    spyOn(lumine.workspace, "open").and.callFake(async (item, options) => {
      if (item === view) {
        arrived.resolve();
        await gate.promise;
      }
      return open(item, options);
    });
    const opening = view.show();
    work.push(opening);
    await arrived.promise;
    const closing = main.deactivate();
    work.push(closing);
    await closing;
    gate.resolve();
    await opening;
    expect(lumine.workspace.paneForItem(view)).toBeUndefined();
  });
  it("emits destruction once for repeated calls on an actual Etch view", async () => {
    view = main.getOutlineView();
    const destroyed = jasmine.createSpy("destroyed");
    view.onDidDestroy(destroyed);
    await view.destroy();
    await view.destroy();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });
  it("releases a native buffer change subscription while shared symbol data remains pending", async () => {
    const gate = deferred(),
      payload = registry();
    payload.getFileSymbolTree = () => gate.promise;
    provide(payload);
    const buffer = editor.getBuffer();
    const before = buffer.emitter.listenerCountForEventName("did-change-text");
    view = main.getOutlineView();
    expect(buffer.emitter.listenerCountForEventName("did-change-text")).toBeGreaterThan(before);
    await view.destroy();
    expect(buffer.emitter.listenerCountForEventName("did-change-text")).toBe(before);
    expect(editor.isDestroyed()).toBe(false);
    gate.resolve([]);
  });
  it("releases a real invalidation subscription returned by a factory that retires the view", async () => {
    view = main.getOutlineView();
    const payload = registry();
    const subscribe = payload.onDidInvalidateFileSymbols;
    let subscription;
    payload.onDidInvalidateFileSymbols = (callback) => {
      subscription = subscribe(callback);
      spyOn(subscription, "dispose").and.callThrough();
      work.push(main.deactivate());
      return subscription;
    };
    provide(payload);
    await Promise.allSettled(work);
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
  });
  it("releases a native icon allocation returned after its actual render retires the view", async () => {
    provide(registry());
    view = main.getOutlineView();
    await conditionPromise(() => view.symbols?.length);
    await new Promise((resolve) => lumine.views.updateDocument(resolve));
    const apply = lumine.icons.applyTo.bind(lumine.icons),
      allocations = [];
    spyOn(lumine.icons, "applyTo").and.callFake((...args) => {
      const allocation = apply(...args);
      spyOn(allocation, "dispose").and.callThrough();
      allocations.push(allocation);
      work.push(main.deactivate());
      return allocation;
    });
    try {
      await view.update();
      await Promise.allSettled(work);
      expect(allocations.length).toBeGreaterThan(0);
      for (const allocation of allocations) expect(allocation.dispose).toHaveBeenCalled();
    } finally {
      for (const allocation of allocations) allocation.dispose();
    }
  });
});
