/**
 * One loopback server per open canvas panel. A panel is registered before its server finishes starting, so
 * concurrent opens of the same instance share one server, and every successful start is paired with exactly one
 * `acquire()` and, when the panel closes, one `release()`.
 */
export class Panels {
    constructor({ start, acquire, release }) {
        this.start = start;
        this.acquire = acquire;
        this.release = release;
        this.entries = new Map();
    }

    /** Resolves with the panel's server entry (`{ url, close }`), starting it on first use. */
    open(instanceId) {
        let pending = this.entries.get(instanceId);
        if (!pending) {
            pending = this.start().then((entry) => {
                this.acquire();
                return entry;
            });
            this.entries.set(instanceId, pending);
            pending.catch(() => {
                if (this.entries.get(instanceId) === pending) this.entries.delete(instanceId);
            });
        }
        return pending;
    }

    async close(instanceId) {
        const pending = this.entries.get(instanceId);
        if (!pending) return;
        this.entries.delete(instanceId);
        const entry = await pending.catch(() => null);
        if (!entry) return; // never started, so never acquired
        this.release();
        await entry.close();
    }

    async closeAll() {
        await Promise.all([...this.entries.keys()].map((instanceId) => this.close(instanceId)));
    }
}
