const { TextBuffer } = require("lumine");

describe("Outline search query budget", () => {
  let view;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("outline-view");
    const View = require("../lib/outline-view");
    view = new View();
  });
  afterEach(() => view.destroy());
  it("shows an unavailable state without reading a giant query and resumes after shrinking", async () => {
    let source = TextBuffer.createTextSnapshot("x".repeat(32768));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    const editor = view.refs.searchEditor;
    const original = editor.getText;
    const read = spyOn(editor, "getText").and.callFake(() => {
      if (editor.getBuffer().getLength() > 4096) throw new Error("must not read giant query");
      return original.call(editor);
    });
    editor.getBuffer().setText(source);
    await view.update();

    expect(view.element.textContent).toContain("Shorten the query to resume");
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    read.and.callThrough();
    editor.setText("small");
    await view.updateSearchResults();
    expect(view.searchQuery).toBe("small");
    expect(view.element.textContent).not.toContain("Shorten the query to resume");
  });
});
