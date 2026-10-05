// Async ddcutil backend: detection, capability discovery, reads and
// coalesced writes. Uses only Gio/GLib so it also runs in prefs and tests.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseDetect, parseCapabilities, parseVcpInfo, parseGetVcp, buildControls, hex} from './parse.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const COMMAND_TIMEOUT_S = 20;

export function findDdcutil(configured = '') {
    if (configured && GLib.file_test(configured, GLib.FileTest.IS_EXECUTABLE))
        return configured;
    return GLib.find_program_in_path('ddcutil') ??
        ['/usr/bin/ddcutil', '/usr/local/bin/ddcutil', '/home/linuxbrew/.linuxbrew/bin/ddcutil']
            .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/** Run a command, resolve with {ok, stdout}. Never rejects on non-zero exit. */
export async function run(argv, {cancellable = null, timeout = COMMAND_TIMEOUT_S} = {}) {
    const proc = new Gio.Subprocess({
        argv,
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    });
    proc.init(cancellable);
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return {ok: proc.get_successful(), stdout: stdout ?? ''};
    } finally {
        GLib.source_remove(timer);
    }
}

/** Serialises commands per I2C bus; DDC/CI cannot handle concurrent access. */
class BusQueue {
    constructor() {
        this._tail = Promise.resolve();
    }

    push(fn) {
        const result = this._tail.then(fn, fn);
        this._tail = result.catch(() => {});
        return result;
    }
}

export class Monitor {
    constructor(backend, display) {
        this._backend = backend;
        Object.assign(this, display);
        this.controls = [];
        this.mccs = '';
        this._pendingWrites = new Map();
        this._writeScheduled = false;
        this._listeners = new Set();
    }

    /** Subscribe to changes: fn(monitor, control). Returns an unsubscribe function. */
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _emit(control) {
        for (const fn of this._listeners) {
            try {
                fn(this, control);
            } catch (e) {
                logError(e);
            }
        }
    }

    get label() {
        const name = this.model || this.mfg || `Bus ${this.bus}`;
        return this.connector ? `${name} (${this.connector})` : name;
    }

    control(code) {
        return this.controls.find(c => c.code === code) ?? null;
    }

    /** Discover the controls this monitor supports. */
    async probe({includeManufacturer = false} = {}) {
        const capsOut = await this._backend.ddc(this.bus, ['capabilities']);
        const caps = parseCapabilities(capsOut.stdout);
        this.mccs = caps.mccs;
        if (caps.features.size === 0) {
            // Monitor does not report capabilities: probe every known code.
            const info = await this._backend.vcpInfo();
            for (const [code, i] of info) {
                if (i.access !== 'ro' && i.access !== 'deprecated')
                    caps.features.set(code, {code, name: i.name, values: []});
            }
        }
        const readable = [...caps.features.keys()];
        const current = readable.length ? await this.read(readable) : new Map();
        this.controls = buildControls({
            caps,
            vcpinfo: await this._backend.vcpInfo(),
            current,
            includeManufacturer,
        });
        return this.controls;
    }

    /** Read current values for the given codes (defaults to all controls). */
    async read(codes = null) {
        codes ??= this.controls.filter(c => c.type !== 'action').map(c => c.code);
        if (!codes.length)
            return new Map();
        const out = await this._backend.ddc(this.bus, ['getvcp', ...codes.map(hex), '--terse']);
        const values = parseGetVcp(out.stdout);
        for (const c of this.controls) {
            const v = values.get(c.code);
            if (!v || v.type === 'ERR' || v.type === 'UNREADABLE')
                continue;
            if (c.type === 'range') {
                c.value = v.value;
                if (v.max > 0)
                    c.max = v.max;
            } else if (c.type === 'choice') {
                c.value = v.type === 'CNC' ? v.value & 0xFF : v.value;
            }
            this._emit(c);
        }
        return values;
    }

    /**
     * Set a value. Rapid calls for the same code are coalesced so a dragged
     * slider only sends the latest value once the bus is free.
     */
    write(code, value) {
        const c = this.control(code);
        if (c && c.type !== 'action')
            c.value = value;
        return new Promise(resolve => {
            const prev = this._pendingWrites.get(code);
            prev?.resolvers.forEach(r => r(false));
            this._pendingWrites.set(code, {value, resolvers: [resolve]});
            this._flush();
        });
    }

    _flush() {
        if (this._writeScheduled)
            return;
        this._writeScheduled = true;
        this._backend.queue(this.bus).push(async () => {
            this._writeScheduled = false;
            const writes = [...this._pendingWrites.entries()];
            this._pendingWrites.clear();
            const written = [];
            for (const [code, {value, resolvers}] of writes) {
                // eslint-disable-next-line no-await-in-loop
                const r = await this._backend.ddcDirect(this.bus,
                    ['setvcp', hex(code), String(Math.round(value)), '--noverify']);
                if (r.ok)
                    written.push([code, Math.round(value), resolvers]);
                else
                    resolvers.forEach(fn => fn(false));
            }
            // Read back once the burst is over. Some monitors accept a write
            // and silently ignore it (e.g. brightness locked by an eco or
            // ambient-light mode); report that instead of pretending.
            if (this._pendingWrites.size > 0) {
                written.forEach(([, , resolvers]) => resolvers.forEach(fn => fn(true)));
                return;
            }
            const verify = written.filter(([code]) => this.control(code)?.type !== 'action');
            const actual = verify.length
                ? parseGetVcp((await this._backend.ddcDirect(this.bus,
                    ['getvcp', ...verify.map(([code]) => hex(code)), '--terse'])).stdout)
                : new Map();
            for (const [code, value, resolvers] of written) {
                const c = this.control(code);
                const a = actual.get(code);
                let ok = true;
                if (c && a && (a.type === 'C' || a.type === 'SNC' || a.type === 'CNC')) {
                    const got = a.type === 'CNC' ? a.value & 0xFF : a.value;
                    ok = got === value;
                    c.value = got;
                    c.locked = !ok;
                    this._emit(c);
                }
                resolvers.forEach(fn => fn(ok));
            }
        });
    }
}

export class DdcutilBackend {
    constructor({binary = '', extraArgs = [], log = () => {}} = {}) {
        this.binary = findDdcutil(binary);
        this.extraArgs = extraArgs;
        this._log = log;
        this._queues = new Map();
        this._vcpInfo = null;
        this.cancellable = new Gio.Cancellable();
    }

    destroy() {
        this.cancellable.cancel();
    }

    queue(bus) {
        if (!this._queues.has(bus))
            this._queues.set(bus, new BusQueue());
        return this._queues.get(bus);
    }

    async _exec(args) {
        if (!this.binary)
            throw new Error('ddcutil not found. Install it (e.g. `sudo dnf install ddcutil`).');
        const argv = [this.binary, ...args, ...this.extraArgs];
        const r = await run(argv, {cancellable: this.cancellable});
        this._log(`${argv.join(' ')} -> ${r.ok ? 'ok' : 'failed'}`);
        return r;
    }

    /** Run a ddcutil command for a bus through that bus's queue. */
    ddc(bus, args) {
        return this.queue(bus).push(() => this.ddcDirect(bus, args));
    }

    /** Run immediately; caller must already hold the bus queue. */
    ddcDirect(bus, args) {
        return this._exec([...args, '--bus', String(bus)]);
    }

    async vcpInfo() {
        if (!this._vcpInfo) {
            const r = await this._exec(['vcpinfo', '--verbose']);
            this._vcpInfo = parseVcpInfo(r.stdout);
        }
        return this._vcpInfo;
    }

    /**
     * Detect all DDC/CI capable monitors and probe their controls.
     * Returns {monitors: Monitor[], unsupported: display[]}
     */
    async scan({includeManufacturer = false} = {}) {
        const r = await this._exec(['detect', '--terse']);
        const displays = parseDetect(r.stdout);
        const unsupported = displays.filter(d => !d.valid);
        const monitors = displays.filter(d => d.valid).map(d => new Monitor(this, d));
        const results = await Promise.allSettled(monitors.map(m => m.probe({includeManufacturer})));
        results.forEach((res, i) => {
            if (res.status === 'rejected')
                this._log(`probe failed for ${monitors[i].label}: ${res.reason}`);
        });
        return {monitors: monitors.filter(m => m.controls.length > 0), unsupported};
    }
}
