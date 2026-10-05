// Monitor Settings: Quick Settings controls for every DDC/CI feature that
// each connected monitor reports.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickSlider, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {DdcutilBackend} from './lib/ddcutil.js';
import {fmt, hex} from './lib/parse.js';

const BRIGHTNESS = 0x10;
const RESCAN_DELAY_MS = 3000;
const CHIP_ROW_CHARS = 40;

const featureKey = (monitor, code) => `${monitor.id}|${hex(code)}`;

/** Slider row for a continuous feature. */
const RangeItem = GObject.registerClass(
class RangeItem extends PopupMenu.PopupBaseMenuItem {
    _init(monitor, control) {
        super._init({reactive: false, style_class: 'monitor-settings-range'});
        this._monitor = monitor;
        this._control = control;

        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        this._name = new St.Label({text: control.name, x_expand: true, style_class: 'monitor-settings-name'});
        this._value = new St.Label({style_class: 'monitor-settings-value'});
        header.add_child(this._name);
        header.add_child(this._value);
        box.add_child(header);

        this._slider = new Slider(0);
        this._slider.accessible_name = control.name;
        this._slider.connect('notify::value', () => {
            if (this._blocked)
                return;
            const v = Math.round(this._slider.value * this._control.max);
            this._value.text = String(v);
            this._monitor.write(this._control.code, v);
        });
        box.add_child(this._slider);
        this.add_child(box);
        this.sync();
    }

    sync() {
        const c = this._control;
        this._blocked = true;
        this._slider.value = c.max > 0 ? c.value / c.max : 0;
        this._blocked = false;
        this._value.text = c.max === 100 ? `${c.value}%` : `${c.value} / ${c.max}`;
        this._name.text = c.locked ? `${c.name} — ${_('locked by monitor')}` : c.name;
    }
});

/** Row of selectable chips for a non-continuous feature. */
const ChoiceItem = GObject.registerClass(
class ChoiceItem extends PopupMenu.PopupBaseMenuItem {
    _init(monitor, control) {
        super._init({reactive: false, style_class: 'monitor-settings-choice'});
        this._monitor = monitor;
        this._control = control;

        const box = new St.BoxLayout({vertical: true, x_expand: true});
        this._name = new St.Label({text: control.name, style_class: 'monitor-settings-name'});
        box.add_child(this._name);

        // Wrap chips into rows by label length.
        const rowsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'monitor-settings-chip-rows'});
        let row = null;
        let rowChars = 0;
        this._buttons = control.values.map(v => {
            if (!row || (rowChars + v.name.length > CHIP_ROW_CHARS && row.get_n_children() > 0)) {
                row = new St.BoxLayout({x_expand: true, style_class: 'monitor-settings-chip-row'});
                rowsBox.add_child(row);
                rowChars = 0;
            }
            rowChars += v.name.length + 3;
            const b = new St.Button({
                label: v.name,
                style_class: 'monitor-settings-chip button',
                can_focus: true,
                toggle_mode: false,
            });
            b.connect('clicked', () => {
                this._control.value = v.value;
                this.sync();
                this._monitor.write(this._control.code, v.value);
            });
            b._value = v.value;
            row.add_child(b);
            return b;
        });
        box.add_child(rowsBox);
        this.add_child(box);
        this.sync();
    }

    sync() {
        for (const b of this._buttons) {
            b.checked = b._value === this._control.value;
            if (b.checked)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this._name.text = this._control.locked
            ? `${this._control.name} — ${_('locked by monitor')}` : this._control.name;
    }
});

/** One-shot action (factory resets) with click-again confirmation. */
const ActionItem = GObject.registerClass(
class ActionItem extends PopupMenu.PopupMenuItem {
    _init(monitor, control, onDone) {
        super._init(control.name, {style_class: 'monitor-settings-action'});
        this._monitor = monitor;
        this._control = control;
        this._armed = false;
        this.activate = () => {
            if (!this._armed) {
                this._armed = true;
                this.label.text = fmt(_('Click again to confirm: %s'), control.name);
                this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    this._disarm();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this._disarm();
            this._monitor.write(control.code, 1).then(() => onDone());
        };
        this.connect('destroy', () => this._disarm());
    }

    _disarm() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._armed = false;
        this.label.text = this._control.name;
    }

    sync() {}
});

const MonitorSettingsSlider = GObject.registerClass(
class MonitorSettingsSlider extends QuickSlider {
    _init(ext) {
        super._init({
            iconName: 'display-brightness-symbolic',
            iconLabel: _('Monitor brightness'),
            menuEnabled: true,
            menuButtonAccessibleName: _('Open monitor settings'),
        });
        this._ext = ext;
        this._settings = ext.getSettings();
        this.slider.accessible_name = _('Monitor brightness');
        this._sliderChangedId = this.slider.connect('notify::value', () => this._onSliderChanged());

        this.menu.setHeader('video-display-symbolic', _('Monitor Settings'));
        this._selectSection = new PopupMenu.PopupMenuSection();
        this._monitorsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._selectSection);
        this.menu.addMenuItem(this._monitorsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addAction(_('Rescan Monitors'), () => ext.rescan());
        this.menu.addAction(_('Monitor Settings Preferences'), () => ext.openPreferences());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._ext.refreshSelected();
        });

        this._items = new Map();
        this._unsubscribe = [];
        this.setMonitors([], [], _('Detecting monitors…'));
    }

    /** Monitors the main slider drives. */
    get targets() {
        const excluded = this._settings.get_strv('main-slider-excluded');
        return this._monitors.filter(m => !excluded.includes(m.id) && m.control(BRIGHTNESS));
    }

    setMonitors(monitors, unsupported, status = '') {
        this._unsubscribe.forEach(fn => fn());
        this._unsubscribe = [];
        this._items.clear();
        this._monitors = monitors;
        this._selectSection.removeAll();
        this._monitorsSection.removeAll();

        const hidden = this._settings.get_strv('hidden-features');
        const withBrightness = monitors.filter(m => m.control(BRIGHTNESS));

        if (withBrightness.length > 1) {
            this._selectSection.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Main slider controls'), {reactive: false, style_class: 'monitor-settings-heading'}));
            for (const m of withBrightness) {
                const excluded = this._settings.get_strv('main-slider-excluded');
                const sw = new PopupMenu.PopupSwitchMenuItem(m.label, !excluded.includes(m.id));
                sw.connect('toggled', (_i, on) => {
                    const list = this._settings.get_strv('main-slider-excluded').filter(id => id !== m.id);
                    if (!on)
                        list.push(m.id);
                    this._settings.set_strv('main-slider-excluded', list);
                    this.syncSlider();
                });
                this._selectSection.addMenuItem(sw);
            }
            this._selectSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        for (const m of monitors) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(m.label, true);
            sub.icon.icon_name = 'video-display-symbolic';
            for (const c of m.controls) {
                if (hidden.includes(featureKey(m, c.code)))
                    continue;
                let item;
                if (c.type === 'range')
                    item = new RangeItem(m, c);
                else if (c.type === 'choice')
                    item = new ChoiceItem(m, c);
                else
                    item = new ActionItem(m, c, () => m.read());
                this._items.set(featureKey(m, c.code), item);
                sub.menu.addMenuItem(item);
            }
            sub.menu.connect('open-state-changed', (_s, open) => {
                if (open)
                    m.read().catch(logError);
            });
            this._monitorsSection.addMenuItem(sub);
            this._unsubscribe.push(m.subscribe((mon, control) => this._onControlChanged(mon, control)));
        }

        const lines = [];
        if (status)
            lines.push(status);
        else if (!monitors.length)
            lines.push(_('No DDC/CI monitors found'));
        else
            lines.push(monitors.length === 1 ? _('1 monitor') : fmt(_('%d monitors'), monitors.length));
        for (const d of unsupported)
            lines.push(fmt(_('%s: no DDC/CI'), d.model || d.connector || `bus ${d.bus}`));
        this._statusItem.label.text = lines.join('\n');
        this.menu.setHeader('video-display-symbolic', _('Monitor Settings'), lines[0]);

        this.slider.reactive = withBrightness.length > 0;
        this.syncSlider();
    }

    _onControlChanged(monitor, control) {
        this._items.get(featureKey(monitor, control.code))?.sync();
        if (control.code === BRIGHTNESS)
            this.syncSlider();
        if (control.locked && !control._notified) {
            control._notified = true;
            Main.notify(fmt(_('%s ignored the %s change'), monitor.label, control.name),
                _('The monitor accepted the command but did not apply it. A monitor mode is probably locking it ' +
                  '(e.g. eco, auto/ambient brightness, low blue light, HDR or a picture preset). Change that mode in the monitor\'s own menu.'));
        }
    }

    syncSlider() {
        const targets = this.targets;
        if (!targets.length)
            return;
        const avg = targets.reduce((s, m) => {
            const c = m.control(BRIGHTNESS);
            return s + c.value / c.max;
        }, 0) / targets.length;
        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = avg;
        this.slider.unblock_signal_handler(this._sliderChangedId);
    }

    _onSliderChanged() {
        this.setBrightness(this.slider.value);
    }

    setBrightness(fraction) {
        fraction = Math.min(1, Math.max(0, fraction));
        for (const m of this.targets) {
            const c = m.control(BRIGHTNESS);
            m.write(BRIGHTNESS, Math.round(fraction * c.max));
            this._items.get(featureKey(m, BRIGHTNESS))?.sync();
        }
    }

    destroy() {
        this._unsubscribe.forEach(fn => fn());
        super.destroy();
    }
});

const MonitorSettingsIndicator = GObject.registerClass(
class MonitorSettingsIndicator extends SystemIndicator {
    _init(ext) {
        super._init();
        this.slider = new MonitorSettingsSlider(ext);
        this.quickSettingsItems.push(this.slider);
    }

    destroy() {
        this.quickSettingsItems.forEach(i => i.destroy());
        super.destroy();
    }
});

export default class MonitorSettingsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new MonitorSettingsIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 2);

        this._settingsIds = [
            'ddcutil-path', 'ddcutil-extra-args', 'show-manufacturer-features',
        ].map(k => this._settings.connect(`changed::${k}`, () => this.rescan()));
        this._settingsIds.push(this._settings.connect('changed::hidden-features', () => this._rebuild()));
        this._settingsIds.push(this._settings.connect('changed::main-slider-excluded', () => this._rebuild()));

        for (const [key, dir] of [['increase-brightness', 1], ['decrease-brightness', -1]]) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this._step(dir));
        }

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRescan());
        this._scanSerial = 0;
        this._monitors = [];
        this._unsupported = [];
        this.rescan();
    }

    disable() {
        Main.wm.removeKeybinding('increase-brightness');
        Main.wm.removeKeybinding('decrease-brightness');
        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        if (this._rescanTimeout)
            GLib.source_remove(this._rescanTimeout);
        this._rescanTimeout = 0;
        this._backend?.destroy();
        this._backend = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
        this._monitors = [];
        this._scanSerial++;
    }

    _log(msg) {
        if (this._settings?.get_boolean('debug'))
            console.log(`[monitor-settings] ${msg}`);
    }

    _scheduleRescan() {
        if (this._rescanTimeout)
            GLib.source_remove(this._rescanTimeout);
        this._rescanTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_DELAY_MS, () => {
            this._rescanTimeout = 0;
            this.rescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    async rescan() {
        const serial = ++this._scanSerial;
        this._backend?.destroy();
        const extra = this._settings.get_string('ddcutil-extra-args').trim();
        this._backend = new DdcutilBackend({
            binary: this._settings.get_string('ddcutil-path'),
            extraArgs: extra ? extra.split(/\s+/) : [],
            log: m => this._log(m),
        });
        this._indicator.slider.setMonitors([], [], _('Detecting monitors…'));
        try {
            const {monitors, unsupported} = await this._backend.scan({
                includeManufacturer: this._settings.get_boolean('show-manufacturer-features'),
            });
            if (serial !== this._scanSerial)
                return;
            this._monitors = monitors;
            this._unsupported = unsupported;
            this._log(`found ${monitors.length} monitor(s): ${monitors.map(m => m.label).join(', ')}`);
            this._rebuild();
        } catch (e) {
            if (serial !== this._scanSerial || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`[monitor-settings] scan failed: ${e.message}`);
            this._indicator?.slider.setMonitors([], [], e.message);
        }
    }

    _rebuild() {
        this._indicator?.slider.setMonitors(this._monitors, this._unsupported);
    }

    refreshSelected() {
        for (const m of this._indicator?.slider.targets ?? [])
            m.read([BRIGHTNESS]).catch(logError);
    }

    _step(direction) {
        const slider = this._indicator?.slider;
        if (!slider || !slider.targets.length)
            return;
        const step = this._settings.get_int('step') / 100;
        const value = Math.min(1, Math.max(0, slider.slider.value + direction * step));
        slider.setBrightness(value);
        slider.syncSlider();
        if (this._settings.get_boolean('show-osd')) {
            Main.osdWindowManager.showAll(Gio.Icon.new_for_string('display-brightness-symbolic'),
                null, slider.slider.value, 1);
        }
    }
}
