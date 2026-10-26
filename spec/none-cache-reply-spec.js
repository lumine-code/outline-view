const { Emitter, Point, Range } = require("lumine");

describe("Outline cached reply across None", () => {
  let main, editor, view, edge, emitter, registry;
  beforeEach(async () => {
    const pkg = await lumine.packages.activatePackage("language-text");
    await pkg.resourceLoadPromise;
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    main = (await lumine.packages.activatePackage("outline-view")).mainModule;
    emitter = new Emitter();
    registry = {
      getFileSymbolTree: async () => [],
      peekFileSymbolTree: () => null,
      onDidInvalidateFileSymbols: (callback) => emitter.on("invalidate", callback),
    };
    edge = main.consumeSymbolRegistry(registry);
    view = main.getOutlineView();
    await view.populateForEditor(editor);
  });
  afterEach(async () => {
    edge.dispose();
    await lumine.packages.deactivatePackage("outline-view");
    emitter.dispose();
    editor.destroy();
  });

  it("rejects an already-settled cache reply and accepts a fresh reply after restoration", async () => {
    const symbol = (name) => ({
      name,
      position: new Point(0, 0),
      range: new Range([0, 0], [0, 1]),
      children: [],
    });
    const stale = [symbol("Old")];
    const query = spyOn(registry, "getFileSymbolTree").and.resolveTo(stale);
    const grammar = editor.getGrammar();
    const pending = view.populateForEditor(editor);
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    await pending;
    expect(view.symbols).toBeNull();
    const fresh = [symbol("Fresh")];
    query.and.resolveTo(fresh);
    await view.populateForEditor(editor);
    expect(view.symbols).toBe(fresh);
  });
});
