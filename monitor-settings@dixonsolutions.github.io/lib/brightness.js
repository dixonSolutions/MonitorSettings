// Bridges DDC/CI monitor brightness into GNOME Shell's *own* brightness
// control instead of drawing a separate slider.
//
// How GNOME drives brightness (Shell 49+):
//   Meta.Backlight (sysfs /sys/class/backlight)
//     -> misc/brightnessManager.js: MonitorBrightnessScale per logical monitor
//       -> `globalScale` + `scales` -> Quick Settings slider, brightness
//          keys, OSD, dimming, auto-brightness, org.gnome.Shell.Brightness
//
// External monitors never appear there: mutter only creates a Meta.Backlight
// for sysfs backlights, and there is no way to synthesise one from an
// extension (Meta.Backlight is an abstract, non-constructible type).
//
// So we vendor a BrightnessScale-compatible object whose "backlight" is the
// monitor's MCCS 0x10 (brightness) feature over DDC/CI, and register it with
// `Main.brightnessManager` under the monitor's logical monitor. Everything
// upstream then behaves exactly as for a laptop panel: one global slider,
// per-monitor sliders in its menu, the brightness keys, the OSD and dimming.

import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BRIGHTNESS = 0x10;
const SCALE_VALUE_N_STEPS = 20;
const EPSILON = 1e-4;

/** Strip the `cardN-` prefix ddcutil adds, e.g. `card1-DP-2` -> `dp-2`. */
function normConnector(s) {
    return (s ?? '').toLowerCase().replace(/^card\d+-/, '');
}

function connectorsMatch(a, b) {
    const na = normConnector(a);
    const nb = normConnector(b);
    return na !== '' && nb !== '' && (na === nb || na.endsWith(nb) || nb.endsWith(na));
}

/**
 * A drop-in replacement for gnome-shell's (module-private) BrightnessScale.
 * Only the surface Main.brightnessManager and the Quick Settings UI use.
 */
export const BrightnessScale = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.float(
            'value', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1.0, 1.0),
    },
    Signals: {
        'destroy': {},
    },
}, class BrightnessScale extends GObject.Object {
    _init(name, value = 1.0, nSteps = SCALE_VALUE_N_STEPS) {
        super._init();
        this._name = name;
        this._value = value;
        this._nSteps = Math.max(1, nSteps);
    }

    get name() {
        return this._name;
    }

    get value() {
        return this._value;
    }

    set value(value) {
        this._setValue(value);
    }

    get nSteps() {
        return this._nSteps;
    }

    stepUp() {
        this._setValue(Math.min(1.0, this._value + (1.0 / this._nSteps)));
    }

    stepDown() {
        this._setValue(Math.max(0.0, this._value - (1.0 / this._nSteps)));
    }

    cycleUp() {
        if (Math.abs(1.0 - this._value) < EPSILON)
            this._setValue(0.0);
        else
            this.stepUp();
    }

    _setValue(value) {
        this._value = Math.min(1.0, Math.max(0.0, value));
        this.notify('value');
    }

    destroy() {
        this.emit('destroy');
    }
});

/** A BrightnessScale whose backlight is one monitor's DDC/CI brightness. */
const DdcBrightnessScale = GObject.registerClass({
    Signals: {
        'backlights-changed': {},
    },
}, class DdcBrightnessScale extends BrightnessScale {
    _init(monitor, logicalMonitor, {log = () => {}} = {}) {
        const control = monitor.control(BRIGHTNESS);
        super._init(monitor.label, control.max > 0 ? control.value / control.max : 1.0);

        this._monitor = monitor;
        this._logicalMonitor = logicalMonitor;
        this._control = control;
        this._log = log;
        this._scaleFactor = 1.0;
        this._lastSynced = -1;

        // Reflect values changed on the monitor itself (OSD menu, another
        // tool) back into GNOME's UI.
        this._unsubscribe = monitor.subscribe((_m, c) => {
            if (c.code !== BRIGHTNESS)
                return;
            this._log(`brightness changed externally: ${c.value}/${c.max}`);
            this.emit('backlights-changed');
        });
    }

    /** The logical monitor GNOME's OSD and per-monitor keys use. */
    get monitor() {
        return this._logicalMonitor;
    }

    _relative() {
        const {value, max} = this._control;
        return max > 0 ? value / max : 0;
    }

    /** Pull the current DDC value into the scale. @returns {boolean} changed */
    syncWithBacklight() {
        const value = this._relative();
        if (Math.abs(value - this._lastSynced) < EPSILON)
            return false;
        this._lastSynced = value;
        this.value = value;
        return true;
    }

    syncWithScale(globalScale) {
        if (!this._followsGlobal)
            return;
        this.value = globalScale.value * this._scaleFactor;
    }

    /**
     * Seed from the value we already know about the monitor. setBacklight()
     * only ever writes a value that differs from the one the monitor reports,
     * so this can never push a stale brightness onto the panel.
     */
    primeFromControl() {
        this._lastSynced = this._relative();
        this.value = this._lastSynced;
    }

    setBacklight(brightness) {
        const {max} = this._control;
        const target = Math.round(Math.min(1, Math.max(0, brightness)) * max);
        this._lastSynced = max > 0 ? target / max : 0;
        if (target === this._control.value)
            return;
        this._log(`write brightness ${target}/${max}`);
        this._monitor.write(BRIGHTNESS, target).catch(logError);
    }

    updateScaleFactor(max) {
        this._scaleFactor = max > 0 ? this.value / max : 1.0;
    }

    /** Whether the main (global) slider drives this monitor. */
    set followsGlobal(follows) {
        this._followsGlobal = follows;
    }

    get followsGlobal() {
        return this._followsGlobal !== false;
    }

    destroy() {
        this._unsubscribe?.();
        super.destroy();
    }
});

/**
 * Registers DDC/CI brightness scales with Main.brightnessManager.
 *
 * Lifecycle: construct once, `setMonitors()` whenever the scan result
 * changes, `uninstall()` on disable. Everything it changes is undone.
 */
export class NativeBrightnessBridge {
    constructor({settings, log = () => {}} = {}) {
        this._settings = settings;
        this._log = log;
        this._manager = Main.brightnessManager;
        this._monitors = [];
        this._scales = new Map(); // monitor.id -> DdcBrightnessScale
        this._keys = []; // logical monitors we occupy in the manager's map
        this._monitorsChangedId = 0;
        this._installed = false;
        this._madeGlobalScale = false;
    }

    /** True once at least one monitor was handed to GNOME's control. */
    get installed() {
        return this._installed && this._scales.size > 0;
    }

    get monitorCount() {
        return this._scales.size;
    }

    install() {
        if (this._installed)
            return;
        this._installed = true;
        // Run after the manager's own handler so we re-add our scales to a
        // freshly rebuilt map.
        this._monitorsChangedId = global.backend.get_monitor_manager().connect_after(
            'monitors-changed', () => this._reinject());
        this._reinject();
    }

    /** Replace the set of bridged monitors (called after each scan). */
    setMonitors(monitors) {
        this._monitors = monitors ?? [];
        if (this._installed)
            this._reinject();
    }

    uninstall() {
        if (!this._installed)
            return;
        this._installed = false;
        if (this._monitorsChangedId) {
            global.backend.get_monitor_manager().disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        // Let the manager rebuild itself from real backlights only; this
        // destroys our scales and restores a native global scale if any.
        this._manager._monitorsChanged();
        this._manager.emit('changed');
        this._scales.clear();
        this._keys = [];
        this._madeGlobalScale = false;
    }

    _reinject() {
        const manager = this._manager;
        if (!manager)
            return;
        // Drop the previous pass: remove our keys from the manager's map
        // (a hotplug rebuild may already have destroyed the scales) and
        // destroy any scale still alive.
        for (const key of this._keys)
            manager._monitorScales.delete(key);
        this._keys = [];
        for (const scale of this._scales.values())
            scale.destroy();
        this._scales.clear();

        const excluded = this._settings.get_strv('main-slider-excluded');
        for (const monitor of this._monitors) {
            const control = monitor.control(BRIGHTNESS);
            if (!control || control.type !== 'range')
                continue;
            const logicalMonitor = this._matchLogicalMonitor(monitor);
            if (!logicalMonitor) {
                this._log(`no logical monitor for ${monitor.label}`);
                continue;
            }
            if (manager._monitorScales.has(logicalMonitor)) {
                // A real backlight already drives this monitor.
                this._log(`${monitor.label} already has a backlight`);
                continue;
            }
            const scale = new DdcBrightnessScale(monitor, logicalMonitor, {log: this._log});
            scale.followsGlobal = !excluded.includes(monitor.id);
            // Mirror gnome-shell's own MonitorBrightnessScale: mark the scale as
            // changed so the manager's next sync normalises the global scale to
            // the monitors' real values, instead of leaving it at its default.
            scale._scaleChanged = true;
            scale.primeFromControl();
            manager._monitorScales.set(logicalMonitor, scale);
            this._keys.push(logicalMonitor);
            this._scales.set(monitor.id, scale);
            // Refresh in the background in case the scan's value was stale.
            monitor.read([BRIGHTNESS]).catch(logError).finally(() => {
                if (!this._scales.has(monitor.id))
                    return;
                manager._sync({showOSD: false});
                manager.emit('changed');
            });
        }

        if (this._scales.size > 0) {
            this._ensureGlobalScale();
        } else if (this._madeGlobalScale) {
            // Never leave a global slider behind with nothing behind it.
            manager._globalScale = null;
            this._madeGlobalScale = false;
        }

        manager._sync({showOSD: false});
        manager.emit('changed');
        this._log(`bridged ${this._scales.size} monitor(s) into GNOME brightness`);
        this._log(`globalScale=${manager._globalScale?.value} scales=[${[...this._scales.values()]
            .map(s => `${s.name}=${s.value.toFixed(3)}(${s._control.value}/${s._control.max})${s._scaleChanged ? ' changed' : ''}`)
            .join(', ')}] globalChanged=${manager._globalScaleChanged}`);
    }

    /**
     * Find the compositor logical monitor a DDC/CI monitor belongs to, by
     * DRM connector. When `brightness-map-unmatched` is set, unmatched
     * monitors are attached to a free logical monitor, which is what makes
     * this testable in a nested/headless shell whose only output is virtual.
     */
    _matchLogicalMonitor(monitor) {
        const monitorManager = global.backend.get_monitor_manager();
        const logicalMonitors = monitorManager.get_logical_monitors();

        for (const logicalMonitor of logicalMonitors) {
            const hit = logicalMonitor.get_monitors()
                .some(m => connectorsMatch(m.get_connector(), monitor.connector));
            if (hit)
                return logicalMonitor;
        }

        if (!this._settings.get_boolean('brightness-map-unmatched'))
            return null;

        return logicalMonitors.find(lm => !this._manager._monitorScales.has(lm)) ?? null;
    }

    /** Create the global scale gnome-shell would have made, if it made none. */
    _ensureGlobalScale() {
        const manager = this._manager;
        if (manager._globalScale)
            return;

        const nSteps = Math.min(...[...this._scales.values()].map(s => s.nSteps));
        manager._globalScale = new BrightnessScale(
            _('Brightness'), 1.0, Number.isFinite(nSteps) ? nSteps : SCALE_VALUE_N_STEPS);
        manager._globalScale.connect('notify::value', () => {
            if (manager._inhibitUpdates)
                return;
            manager._globalScaleChanged = true;
            manager._sync();
            manager.emit('user-update');
        });
        this._madeGlobalScale = true;
    }
}
