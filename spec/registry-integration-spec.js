const fs = require("fs");
const os = require("os");
const path = require("path");
const { Emitter } = require("lumine");
const packagePath = (name) => {
  const sibling = path.resolve(__dirname, "..", "..", name);
  return fs.existsSync(sibling) ? sibling : name;
};

describe("outline-view real symbol registry integration", () => {
  let editor;
  let view;
  let registry;
  let sourceRegistration;
  let sourceEmitter;
  let otherEditors;
  let useMockClock = false;

  beforeEach(async () => {
    if (!useMockClock) jasmine.useRealClock();
    otherEditors = [];
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    for (const name of ["language-javascript", "symbol", "symbol-tree-sitter"]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
    const pack = await lumine.packages.activatePackage(path.resolve(__dirname, ".."));
    registry = lumine.packages.getActivePackage("symbol").mainModule.provideSymbolRegistry();
    lumine.config.set("symbol.documentSource", "auto", { scopeSelector: ".source.js" });
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
    registry?.setDocumentSource(editor, null);
    sourceRegistration?.dispose();
    sourceRegistration = null;
    sourceEmitter?.dispose();
    sourceEmitter = null;
    for (const other of otherEditors) other.destroy();
    lumine.config.set("symbol.documentSource", "auto", { scopeSelector: ".source.js" });
    editor?.destroy();
    await lumine.packages.deactivatePackage("language-text");
    for (const name of [
      "outline-view",
      "breadcrumbs",
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

  function currentName() {
    return view.element.querySelector("li.current .name-inner")?.textContent;
  }

  async function openBreadcrumbs() {
    const pack = await lumine.packages.activatePackage(packagePath("breadcrumbs"));
    const pane = lumine.workspace.getCenter().getActivePane();
    const breadcrumbsView = pack.mainModule.ensureController().views.get(pane);
    return {
      view: breadcrumbsView,
      names: () =>
        Array.from(
          breadcrumbsView.element.querySelectorAll(".breadcrumbs-symbol"),
          (element) => element.textContent,
        ),
    };
  }

  async function registerSource() {
    sourceEmitter = new Emitter();
    const source = {
      name: "Consumer Structure",
      packageName: "consumer-symbol-fixture",
      mode: "symbols",
      calls: 0,
      complete: null,
      onDidInvalidateDocumentSymbols(callback) {
        return sourceEmitter.on("invalidate", callback);
      },
      getDocumentSymbolSources() {
        return [
          {
            id: "consumer:structure",
            name: "Consumer Structure",
            shortLabel: "Test",
            score: 0.1,
            state: this.mode === "unavailable" ? "unavailable" : "ready",
          },
        ];
      },
      getDocumentSymbols() {
        this.calls++;
        if (this.mode === "empty") return [];
        if (this.mode === "error") throw new Error("Selected source failed");
        if (this.mode === "pending") {
          return new Promise((resolve) => (this.complete = resolve));
        }
        return [
          {
            name: "Semantic",
            tag: "class",
            position: [0, 0],
            range: [
              [0, 0],
              [6, 0],
            ],
          },
        ];
      },
      invalidate() {
        sourceEmitter.emit("invalidate", { editor });
      },
    };
    sourceRegistration = lumine.packages.serviceHub.provide("symbol.document-provider", {
      "1.0.0": source,
    });
    await registry.getFileSymbolTree(editor);
    const descriptor = (await registry.listDocumentSources(editor)).find(
      ({ name }) => name === "Consumer Structure",
    );
    expect(descriptor).toBeDefined();
    return { source, id: descriptor.id };
  }

  it("tracks the deepest parsed symbol throughout its body without selecting it", async () => {
    await waitForFrames(() => currentName() === "inner", {
      description: "the cursor inside the method body to mark the method current",
    });
    expect(view.element.querySelector("li.selected")).toBeNull();

    editor.setCursorBufferPosition([4, 0]);
    await waitForFrames(() => currentName() === "Outer", {
      description: "the cursor on the class boundary to mark the class current",
    });
    expect(currentName()).toBe("Outer");
    editor.setCursorBufferPosition([5, 9]);
    await waitForFrames(() => currentName() === "after", {
      description: "the cursor on the next function to mark that function current",
    });
    expect(currentName()).toBe("after");
    expect(view.element.querySelector("li.selected")).toBeNull();
  });

  it("navigates real symbols and retires a withdrawn provider generation", async () => {
    const inner = Array.from(view.element.querySelectorAll(".name-inner")).find(
      (element) => element.textContent === "inner",
    );
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitForFrames(
      () =>
        editor.getCursorBufferPosition().isEqual([1, 2]) &&
        lumine.views.getView(editor).contains(document.activeElement),
      { description: "the real symbol navigation to focus its editor" },
    );
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
    expect(await registry.getFileSymbolTree(editor)).toEqual([]);
    expect(registry.getDocumentSourceState(editor).status).toBe("ready");
    expect(registry.getDocumentSourceState(editor).source.id).toBe("symbol-tree-sitter");
    await waitForFrames(
      () =>
        names().length === 0 &&
        view.element.querySelector("background-tips")?.textContent === "No symbols",
      { description: "a grammar without tags to render its empty ready state" },
    );
    expect(view.element.querySelector("background-tips").textContent).toBe("No symbols");
  });

  it("switches all consumers through one shared fetch and reuses each current source", async () => {
    const breadcrumbs = await openBreadcrumbs();
    const { source, id } = await registerSource();
    await waitForFrames(() => breadcrumbs.names().includes("inner") && names().includes("inner"), {
      description: "Auto to show the real Tree-sitter result in both consumers",
    });
    registry.setDocumentSource(editor, id);
    await Promise.all([registry.getFileSymbols(editor), registry.getFileSymbolTree(editor)]);
    await waitForFrames(
      () => names().includes("Semantic") && breadcrumbs.names().includes("Semantic"),
      {
        description: "the selected source to replace both consumer trees",
      },
    );
    expect(source.calls).toBe(1);
    expect(names()).not.toContain("inner");
    expect(breadcrumbs.names()).not.toContain("inner");
    registry.setDocumentSource(editor, null);
    await waitForFrames(() => names().includes("inner") && breadcrumbs.names().includes("inner"), {
      description: "Auto to restore the shared Tree-sitter result",
    });
    registry.setDocumentSource(editor, id);
    await waitForFrames(
      () => names().includes("Semantic") && breadcrumbs.names().includes("Semantic"),
      {
        description: "switching back to reuse the current selected source cache",
      },
    );
    expect(source.calls).toBe(1);
  });

  describe("fast refreshes", () => {
    beforeAll(() => (useMockClock = true));
    afterAll(() => (useMockClock = false));
    for (const trigger of ["typing", "save"]) {
      it(`keeps outline and breadcrumb contents visible while a fast ${trigger} refresh replaces them`, async () => {
        const savedPath =
          trigger === "save"
            ? path.join(os.tmpdir(), `lumine-outline-save-${process.pid}-${Date.now()}.js`)
            : null;
        if (savedPath) {
          editor.getBuffer().setPath(savedPath);
          await registry.getFileSymbolTree(editor);
        }
        const breadcrumbs = await openBreadcrumbs();
        const { source, id } = await registerSource();
        registry.setDocumentSource(editor, id);
        await waitForFrames(
          () => names().includes("Semantic") && breadcrumbs.names().includes("Semantic"),
          { description: "the selected source's initial symbols to reach both consumers" },
        );
        const emptyStates = [];
        const observer = new MutationObserver(() => {
          if (
            !names().length ||
            !breadcrumbs.names().length ||
            view.element.querySelector("background-tips")
          ) {
            emptyStates.push(true);
          }
        });
        observer.observe(view.element, { childList: true, subtree: true });
        observer.observe(breadcrumbs.view.element, { childList: true, subtree: true });
        try {
          source.mode = "pending";
          if (trigger === "typing") {
            editor.insertText(" ");
            advanceClock(300);
          } else {
            await editor.save();
          }
          await flushMicrotasks();
          expect(source.complete).toEqual(jasmine.any(Function));
          advanceClock(150);
          await view.update();
          expect(names()).toEqual(["Semantic"]);
          expect(breadcrumbs.names()).toEqual(["Semantic"]);
          expect(view.element.querySelector("background-tips")).toBeNull();
          source.complete([
            {
              name: "Updated",
              tag: "class",
              position: [0, 0],
              range: [
                [0, 0],
                [6, 0],
              ],
            },
          ]);
          await waitForFrames(
            () => names().includes("Updated") && breadcrumbs.names().includes("Updated"),
            { description: "fresh symbols to replace both retained consumer views" },
          );
          expect(emptyStates).toEqual([]);
        } finally {
          observer.disconnect();
          if (savedPath && fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
        }
      });
    }
  });

  it("clears the selected source's empty, unavailable and failed results without fallback", async () => {
    const breadcrumbs = await openBreadcrumbs();
    const filePath = breadcrumbs.view.fileContent.textContent;
    const { source, id } = await registerSource();
    registry.setDocumentSource(editor, id);
    await waitForFrames(() => names().includes("Semantic"), {
      description: "the selected source's initial tree to render",
    });
    source.mode = "empty";
    source.invalidate();
    expect(await registry.getFileSymbolTree(editor)).toEqual([]);
    await waitForFrames(
      () => view.element.querySelector("background-tips")?.textContent === "No symbols",
      {
        description: "a valid empty result to clear the selected outline",
      },
    );
    expect(breadcrumbs.names()).toEqual([]);
    expect(breadcrumbs.view.fileContent.textContent).toBe(filePath);
    for (const mode of ["unavailable", "error"]) {
      source.mode = "symbols";
      source.invalidate();
      await waitForFrames(
        () => names().includes("Semantic") && breadcrumbs.names().includes("Semantic"),
        {
          description: "the selected source to recover before the next failure",
        },
      );
      source.mode = mode;
      source.invalidate();
      expect(await registry.getFileSymbolTree(editor)).toBeNull();
      await waitForFrames(() => names().length === 0 && breadcrumbs.names().length === 0, {
        description: "the selected source's failure to clear obsolete symbols",
      });
      expect(names()).not.toContain("inner");
      expect(breadcrumbs.view.fileContent.textContent).toBe(filePath);
    }
  });

  it("keeps file choices independent and applies grammar choices to inheriting editors", async () => {
    const firstPane = lumine.workspace.getCenter().getActivePane();
    const firstBreadcrumbs = await openBreadcrumbs();
    const { source, id } = await registerSource();
    const other = lumine.workspace.buildTextEditor();
    otherEditors.push(other);
    other.setGrammar(editor.getGrammar());
    other.setText(editor.getText());
    const secondPane = firstPane.splitRight({ items: [other] });
    other.setCursorBufferPosition([2, 6]);
    await other.whenGrammarSettled();
    await registry.getFileSymbolTree(other);
    secondPane.activate();
    const secondBreadcrumbs = await openBreadcrumbs();
    await waitForFrames(
      () => names().includes("inner") && secondBreadcrumbs.names().includes("inner"),
      {
        description: "the second editor's Auto source to reach both consumers",
      },
    );

    registry.setDocumentSource(editor, id);
    await waitForFrames(() => firstBreadcrumbs.names().includes("Semantic"), {
      description: "a file choice to change only that editor's breadcrumb tree",
    });
    expect(secondBreadcrumbs.names()).toContain("inner");
    expect(names()).toContain("inner");
    expect(source.calls).toBe(1);

    const treeSitter = (await registry.listDocumentSources(editor)).find(
      ({ name }) => name === "Tree-sitter",
    );
    registry.setDocumentSource(editor, treeSitter.id);
    await waitForFrames(() => firstBreadcrumbs.names().includes("inner"), {
      description: "the first editor to retain an explicit Tree-sitter file choice",
    });
    registry.setDocumentSource(other, id, { scope: "grammar" });
    await waitForFrames(
      () => names().includes("Semantic") && secondBreadcrumbs.names().includes("Semantic"),
      {
        description: "the grammar choice to refresh its inheriting editor and outline",
      },
    );
    expect(firstBreadcrumbs.names()).toContain("inner");
    expect(registry.getDocumentSourceState(editor).scope).toBe("file");
    expect(registry.getDocumentSourceState(other).scope).toBe("grammar");
    expect(source.calls).toBe(2);
  });

  it("withdraws a previous selected source after the grace period while its late response is pending", async () => {
    const breadcrumbs = await openBreadcrumbs();
    const filePath = breadcrumbs.view.fileContent.textContent;
    const { source, id } = await registerSource();
    source.mode = "pending";
    registry.setDocumentSource(editor, id);
    await waitForFrames(
      () => source.complete && names().length === 0 && breadcrumbs.names().length === 0,
      {
        description: "the source switch to clear the old outline before a reply",
      },
    );
    const pending = registry.getFileSymbolTree(editor);
    registry.setDocumentSource(editor, null);
    await waitForFrames(() => names().includes("inner") && breadcrumbs.names().includes("inner"), {
      description: "the newer Auto request to restore Tree-sitter symbols",
    });
    source.complete([
      {
        name: "Late",
        position: [0, 0],
        range: [
          [0, 0],
          [6, 0],
        ],
      },
    ]);
    expect(await pending).toBeNull();
    await view.update();
    expect(names()).not.toContain("Late");
    expect(names()).toContain("inner");
    expect(breadcrumbs.names()).not.toContain("Late");
    expect(breadcrumbs.view.fileContent.textContent).toBe(filePath);
    expect((await registry.getFileSymbols(editor)).some(({ name }) => name === "Late")).toBe(false);
  });
});
