import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DdcutilBackend, findDdcutil} from './lib/ddcutil.js';
import {fmt, hex} from './lib/parse.js';

export default class MonitorSettingsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({title: _('Monitor Settings'), icon_name: 'video-display-symbolic'});
        window.add(page);

        // Detected monitors
        const monitorsGroup = new Adw.PreferencesGroup({
            title: _('Detected Monitors'),
            description: _('Everything below is read from the monitors themselves via DDC/CI. Turn off any control you do not want in the menu.'),
        });
        const rescan = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Rescan')});
        rescan.add_css_class('flat');
        monitorsGroup.set_header_suffix(rescan);
        page.add(monitorsGroup);

        let rows = [];
        const populate = async () => {
            rows.forEach(r => monitorsGroup.remove(r));
            rows = [];
            const spinner = new Adw.ActionRow({title: _('Detecting monitors…')});
            spinner.add_suffix(new Adw.Spinner());
            monitorsGroup.add(spinner);
            rows.push(spinner);
            const extra = settings.get_string('ddcutil-extra-args').trim();
            const backend = new DdcutilBackend({
                binary: settings.get_string('ddcutil-path'),
                extraArgs: extra ? extra.split(/\s+/) : [],
            });
            let result;
            try {
                result = await backend.scan({includeManufacturer: settings.get_boolean('show-manufacturer-features')});
            } catch (e) {
                result = {monitors: [], unsupported: [], error: e.message};
            }
            monitorsGroup.remove(spinner);
            rows = [];
            if (result.error || !result.monitors.length) {
                const r = new Adw.ActionRow({
                    title: result.error ?? _('No DDC/CI monitors found'),
                    subtitle: _('Make sure ddcutil is installed, the i2c-dev module is loaded and DDC/CI is enabled in the monitor\'s own menu.'),
                });
                monitorsGroup.add(r);
                rows.push(r);
            }
            for (const m of result.monitors) {
                const exp = new Adw.ExpanderRow({
                    title: m.label,
                    subtitle: fmt(_('%s · I²C bus %d · MCCS %s · %d controls'), m.mfg, m.bus, m.mccs || '?', m.controls.length),
                });
                if (m.control(0x10)) {
                    const main = new Adw.SwitchRow({title: _('Driven by the main brightness slider'),
                        active: !settings.get_strv('main-slider-excluded').includes(m.id)});
                    main.connect('notify::active', () => toggleList(settings, 'main-slider-excluded', m.id, !main.active));
                    exp.add_row(main);
                }
                for (const c of m.controls) {
                    const key = `${m.id}|${hex(c.code)}`;
                    const desc = c.type === 'range' ? fmt(_('Slider, 0–%d'), c.max)
                        : c.type === 'choice' ? c.values.map(v => v.name).join(', ')
                            : _('Action');
                    const row = new Adw.SwitchRow({
                        title: `${c.name}`,
                        subtitle: `0x${hex(c.code)} · ${desc}`,
                        active: !settings.get_strv('hidden-features').includes(key),
                    });
                    row.connect('notify::active', () => toggleList(settings, 'hidden-features', key, !row.active));
                    exp.add_row(row);
                }
                monitorsGroup.add(exp);
                rows.push(exp);
            }
            for (const d of result.unsupported) {
                const r = new Adw.ActionRow({
                    title: d.model || d.connector || `bus ${d.bus}`,
                    subtitle: fmt(_('No DDC/CI (%s). Laptop panels are handled by GNOME\'s built-in brightness slider.'), d.reason),
                });
                monitorsGroup.add(r);
                rows.push(r);
            }
        };
        rescan.connect('clicked', () => populate().catch(logError));
        populate().catch(logError);

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviour);
        const step = new Adw.SpinRow({
            title: _('Keyboard step (%)'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 50, step_increment: 1}),
        });
        settings.bind('step', step, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(step);
        const osd = new Adw.SwitchRow({title: _('Show on-screen display for shortcuts')});
        settings.bind('show-osd', osd, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(osd);
        const mfg = new Adw.SwitchRow({
            title: _('Show manufacturer-specific features'),
            subtitle: _('VCP codes 0xE0–0xFF. Their meaning is undocumented and differs per model.'),
        });
        settings.bind('show-manufacturer-features', mfg, 'active', Gio.SettingsBindFlags.DEFAULT);
        mfg.connect('notify::active', () => populate().catch(logError));
        behaviour.add(mfg);
        const native = new Adw.SwitchRow({
            title: _('Use GNOME\u2019s own brightness control'),
            subtitle: _('Drive each monitor\u2019s DDC/CI brightness from the built-in Quick Settings slider, the brightness keys, the OSD and night light dimming. No separate brightness slider is added.'),
        });
        settings.bind('native-brightness', native, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(native);

        // Shortcuts
        const shortcuts = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: GLib.markup_escape_text(
                _('GTK accelerator syntax, e.g. <Control>XF86MonBrightnessUp or <Super>F6. Leave empty to disable.'), -1),
        });
        page.add(shortcuts);
        for (const [key, title] of [['increase-brightness', _('Increase brightness')], ['decrease-brightness', _('Decrease brightness')]]) {
            const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] ?? '', show_apply_button: true});
            row.connect('apply', () => {
                const text = row.text.trim();
                if (text && !Gtk.accelerator_parse(text)[0]) {
                    row.add_css_class('error');
                    return;
                }
                row.remove_css_class('error');
                settings.set_strv(key, text ? [text] : []);
            });
            shortcuts.add(row);
        }

        // Advanced
        const advanced = new Adw.PreferencesGroup({title: _('Advanced')});
        page.add(advanced);
        const path = new Adw.EntryRow({
            title: fmt(_('ddcutil path (auto-detected: %s)'), findDdcutil() ?? _('not found')),
            text: settings.get_string('ddcutil-path'),
            show_apply_button: true,
        });
        path.connect('apply', () => settings.set_string('ddcutil-path', path.text.trim()));
        advanced.add(path);
        const args = new Adw.EntryRow({
            title: _('Extra ddcutil arguments'),
            text: settings.get_string('ddcutil-extra-args'),
            show_apply_button: true,
        });
        args.connect('apply', () => {
            settings.set_string('ddcutil-extra-args', args.text.trim());
            populate().catch(logError);
        });
        advanced.add(args);
        const debug = new Adw.SwitchRow({title: _('Debug logging'), subtitle: _('Log every ddcutil call to the journal')});
        settings.bind('debug', debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(debug);
        const unmatched = new Adw.SwitchRow({
            title: _('Bridge monitors missing from the display layout'),
            subtitle: _('Off: a monitor is only handed to GNOME when its connector matches a screen. On: a monitor with no matching output is attached to a free screen. Needed in nested or headless test shells, whose only output is virtual.'),
        });
        settings.bind('brightness-map-unmatched', unmatched, 'active', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(unmatched);
    }
}

function toggleList(settings, key, value, present) {
    const list = settings.get_strv(key).filter(v => v !== value);
    if (present)
        list.push(value);
    settings.set_strv(key, list);
}
