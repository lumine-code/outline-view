const fs = require("fs");
const path = require("path");
const packagePath = (name) => {
  const sibling = path.resolve(__dirname, "..", "..", name);
  return fs.existsSync(sibling) ? sibling : name;
};

describe("outline-view real symbol registry integration", () => {
  let editor;
  let view;
  let registry;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    for (const name of ["language-javascript", "symbol", "symbol-tree-sitter"]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
    const pack = await lumine.packages.activatePackage(path.resolve(__dirname, ".."));
    registry = lumine.packages.getActivePackage("symbol").mainModule.provideSymbolRegistry();
    editor = await lumine.workspace.open(path.resolve(__dirname, "..", "package.json"));
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
    editor.setText("class Outer {\n  inner() {\n    return 1;\n  }\n}\nfunction after() {}\n");
    await editor.whenGrammarSettled();
    await registry.getFileSymbolTree(editor);
    view = pack.mainModule.getOutlineView();
    await view.show();
    editor.setCursorBufferPosition([2, 6]);
    await waitForFrames(() => names().includes("inner"), {
      description: "parsed symbols to reach the consumer through ServiceHub",
    });
  });

  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("language-text");
    for (const name of [
      "outline-view",
      "symbol-tree-sitter",
      "symbol",
      "language-javascript",
      "language-text",
    ]) {
      await lumine.packages.deactivatePackage(name);
    }
  });

  function names() {
    return Array.from(
      view.element.querySelectorAll(".name-inner"),
      (element) => element.textContent,
    );
  }

  it("navigates real symbols and retires a withdrawn provider generation", async () => {
    const inner = Array.from(view.element.querySelectorAll(".name-inner")).find(
      (element) => element.textContent === "inner",
    );
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(editor.getCursorBufferPosition().isEqual([1, 2])).toBe(true);
    await lumine.packages.deactivatePackage("symbol-tree-sitter");
    await waitForFrames(() => names().length === 0, {
      description: "symbols from the withdrawn provider to disappear",
    });
    expect(view.element.querySelector("background-tips").textContent).toBe(
      "Symbol information is unavailable.",
    );
    await lumine.packages.activatePackage(packagePath("symbol-tree-sitter"));
    await registry.getFileSymbolTree(editor);
    editor.setCursorBufferPosition([2, 6]);
    await waitForFrames(() => names().includes("inner"), {
      description: "the replacement provider to restore symbols",
    });
  });

  it("refreshes unsaved edits and clears symbols for a grammar without tags", async () => {
    editor.setText(editor.getText().replace("inner", "updated"));
    await editor.whenGrammarSettled();
    await registry.getFileSymbolTree(editor);
    editor.setCursorBufferPosition([2, 6]);
    await waitForFrames(() => names().includes("updated"), {
      description: "unsaved symbols to replace the previous names",
    });
    expect(names()).not.toContain("inner");
    await lumine.packages.activatePackage(packagePath("language-text"));
    editor.setGrammar(lumine.grammars.grammarForScopeName("text.plain"));
    await editor.whenGrammarSettled();
    expect(await registry.getFileSymbolTree(editor)).toBeNull();
    await waitForFrames(() => names().length === 0, {
      description: "unsupported grammar to clear the previous symbols",
    });
    expect(view.element.querySelector("background-tips").textContent).toBe(
      "Symbol information is unavailable.",
    );
  });
});
