const OutlineView = require("../lib/outline-view");

describe("Outline horizontal overlay reveal", () => {
  it("keeps the selected row above the rail and restores the full viewport without it", () => {
    const scroller = document.createElement("div");
    const entry = document.createElement("li");
    scroller.style.cssText = "position:relative;height:100px;width:200px;overflow:auto";
    entry.style.cssText = "position:absolute;top:80px;height:20px";
    const filler = document.createElement("div");
    filler.style.height = "200px";
    scroller.append(entry, filler);
    jasmine.attachToDOM(scroller);
    const view = Object.create(OutlineView.prototype);
    view.refs = { scroller };
    view.scrollbarGeometry = { scrollEndInset: 10 };
    view.scrollEntryIntoViewIfNeeded(entry);
    expect(scroller.scrollTop).toBe(10);
    scroller.scrollTop = 0;
    view.scrollbarGeometry = { scrollEndInset: 0 };
    view.scrollEntryIntoViewIfNeeded(entry);
    expect(scroller.scrollTop).toBe(0);
  });
});
