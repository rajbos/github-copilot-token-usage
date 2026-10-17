import assert from "node:assert/strict";
import { test } from "node:test";
import { Panels } from "../panels.mjs";

function harness({ failFirst = false } = {}) {
    const counts = { starts: 0, acquires: 0, releases: 0, closes: 0 };
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const panels = new Panels({
        start: async () => {
            counts.starts++;
            await gate;
            if (failFirst && counts.starts === 1) throw new Error("port in use");
            return { url: `http://127.0.0.1/${counts.starts}/`, close: async () => void counts.closes++ };
        },
        acquire: () => counts.acquires++,
        release: () => counts.releases++,
    });
    return { panels, counts, release };
}

test("concurrent opens of one panel share a single server and refresher user", async () => {
    const { panels, counts, release } = harness();
    const first = panels.open("a");
    const second = panels.open("a");
    release();
    assert.equal(await first, await second);
    assert.deepEqual(counts, { starts: 1, acquires: 1, releases: 0, closes: 0 });
    await panels.close("a");
    await panels.close("a");
    assert.deepEqual(counts, { starts: 1, acquires: 1, releases: 1, closes: 1 });
});

test("closing a panel while its server is still starting releases exactly once", async () => {
    const { panels, counts, release } = harness();
    const opening = panels.open("a");
    const closing = panels.close("a");
    release();
    await opening;
    await closing;
    assert.deepEqual(counts, { starts: 1, acquires: 1, releases: 1, closes: 1 });
});

test("a failed start acquires nothing and can be retried", async () => {
    const { panels, counts, release } = harness({ failFirst: true });
    release();
    await assert.rejects(panels.open("a"), /port in use/);
    await panels.close("a");
    assert.deepEqual(counts, { starts: 1, acquires: 0, releases: 0, closes: 0 });
    await panels.open("a");
    assert.equal(counts.acquires, 1);
});

test("closeAll closes every panel once", async () => {
    const { panels, counts, release } = harness();
    release();
    await Promise.all([panels.open("a"), panels.open("b")]);
    await panels.closeAll();
    await panels.closeAll();
    assert.deepEqual(counts, { starts: 2, acquires: 2, releases: 2, closes: 2 });
});
