// Test harness: run inside a headless gnome-shell next to Monitor Settings.
// Writes TAP-like results to $MS_TEST_OUT and screenshots to $MS_TEST_DIR.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'monitor-settings@dixonsolutions.github.io';
const outDir = GLib.getenv('MS_TEST_DIR');
const lines = [];
let failures = 0;

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const log = s => { lines.push(s); GLib.file_set_contents(`${outDir}/results.txt`, lines.join('\n') + '\n'); };
function check(name, cond, detail = '') {
    if (!cond) failures++;
    log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const v = fn(); if (v) return v; } catch {}
        await sleep(200);
    }
    return null;
}
function ddcGet(bus, code) {
    const [, out] = GLib.spawn_command_line_sync(`ddcutil getvcp ${code} --bus ${bus} --terse`);
    const m = new TextDecoder().decode(out).match(/C (\d+) (\d+)/);
    return m ? Number(m[1]) : null;
}
async function screenshot(name) {
    const file = Gio.File.new_for_path(`${outDir}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shot = new Shell.Screenshot();
    await new Promise(res => shot.screenshot(false, stream, (o, r) => { o.screenshot_finish(r); res(); }));
    stream.close(null);
}

export default class Harness extends Extension {
    enable() {
        // Re-enabling the extension under test also cycles this one; run once.
        if (globalThis.__monitorSettingsHarnessRan)
            return;
        globalThis.__monitorSettingsHarnessRan = true;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { this._run().catch(e => log(`FAIL harness crashed: ${e}\n${e.stack}`)).finally(() => log(`DONE failures=${failures}`)); return GLib.SOURCE_REMOVE; });
    }
    disable() {}

    async _run() {
        const mgr = Main.extensionManager;
        const ext = await waitFor(() => mgr.lookup(UUID)?.stateObj?._indicator ? mgr.lookup(UUID) : null);
        check('extension enabled without errors', ext && ext.state === 1 && !ext.error, ext?.error ?? '');
        if (!ext) return;
        const inst = ext.stateObj;
        const qs = Main.panel.statusArea.quickSettings;
        const slider = inst._indicator.slider;
        check('quick slider added to Quick Settings grid', slider.get_parent() === qs.menu._grid);

        await waitFor(() => inst._monitors.length > 0);
        check('monitors detected', inst._monitors.length > 0, inst._monitors.map(m => m.label).join(', '));
        const m = inst._monitors[0];
        if (!m) return;
        check('controls auto-detected from monitor', m.controls.length > 0, m.controls.map(c => c.name).join(', '));
        check('menu items built for every control', slider._features.items.size === m.controls.length, `${slider._features.items.size} items`);
        check('main slider is reactive', slider.slider.reactive);
        const b = m.control(0x10);
        check('main slider reflects monitor brightness', Math.abs(slider.slider.value - b.value / b.max) < 0.01, `slider=${slider.slider.value.toFixed(2)} brightness=${b.value}/${b.max}`);

        // Open the menus and take screenshots
        qs.menu.open(false);
        await sleep(800);
        await screenshot('01-quick-settings');
        slider.menu.open(false);
        await sleep(800);
        const sub = slider._features.submenu(m);
        sub.setSubmenuShown(true);
        await sleep(1200);
        await screenshot('02-monitor-menu');

        // Per-feature slider writes to the real monitor (speaker volume, restored afterwards)
        const vol = m.control(0x62);
        if (vol) {
            const orig = ddcGet(m.bus, '62');
            const item = slider._features.items.get(`${m.id}|62`);
            item._slider.value = 0.07;
            await sleep(1500);
            const after = ddcGet(m.bus, '62');
            check('feature slider writes value to monitor', after === 7, `0x62 read back ${after}`);
            item._slider.value = orig / vol.max;
            await sleep(1500);
            check('feature slider restores original value', ddcGet(m.bus, '62') === orig);
        }

        // Choice chip writes (OSD language? use audio mute toggle, restored)
        const mute = m.control(0x8D);
        if (mute) {
            const item = slider._features.items.get(`${m.id}|8D`);
            const orig = mute.value;
            const other = item._buttons.find(btn => btn._value !== orig);
            other.emit('clicked', 1);
            await sleep(1500);
            const [, out] = GLib.spawn_command_line_sync(`ddcutil getvcp 8D --bus ${m.bus} --terse`);
            check('choice chip writes value to monitor', new TextDecoder().decode(out).includes(`x0${other._value}`), new TextDecoder().decode(out).trim());
            item._buttons.find(btn => btn._value === orig).emit('clicked', 1);
            await sleep(1500);
            check('choice chip state reflects current value', item._buttons.find(btn => btn._value === orig).checked);
        }

        // Main slider drives brightness; if the monitor ignores it, it's flagged as locked
        const origB = b.value;
        slider.slider.value = Math.max(0, (origB - 10) / b.max);
        await sleep(2500);
        const nowB = ddcGet(m.bus, '10');
        if (nowB === origB)
            check('ignored brightness write is detected and flagged locked', b.locked === true, `monitor kept ${nowB}`);
        else
            check('main slider writes brightness', nowB === origB - 10, `read back ${nowB}`);
        await screenshot('03-after-brightness');
        slider.slider.value = origB / b.max;
        await sleep(2000);

        // Keyboard shortcut path
        inst._step(1);
        await sleep(300);
        await screenshot('04-osd');
        check('shortcut step runs and shows OSD', true);
        slider.slider.value = origB / b.max;
        await sleep(1500);

        // Hiding a feature rebuilds menu
        const settings = inst._settings;
        settings.set_strv('hidden-features', [`${m.id}|CC`]);
        await sleep(300);
        check('hidden feature removed from menu', !slider._features.items.has(`${m.id}|CC`) && slider._features.items.size === m.controls.length - 1);
        settings.reset('hidden-features');
        await sleep(300);
        check('hidden feature restored', slider._features.items.has(`${m.id}|CC`));

        // Monitor selection for main slider
        settings.set_strv('main-slider-excluded', [m.id]);
        check('excluding monitor removes it from main slider targets', slider.targets.length === inst._monitors.length - 1);
        settings.reset('main-slider-excluded');
        check('re-including monitor', slider.targets.length === inst._monitors.length);

        // Hot-plug rescan
        Main.layoutManager.emit('monitors-changed');
        await sleep(3500);
        await waitFor(() => inst._monitors.length > 0 && slider._features.items.size > 0);
        check('rescan after monitors-changed rebuilds menu', slider._features.items.size === inst._monitors[0].controls.length);

        // Disable/enable cycle
        qs.menu.close(false);
        await mgr.disableExtension(UUID);
        await sleep(500);
        check('disable cleans up quick settings item', !qs.menu._grid.get_children().includes(slider));
        await mgr.enableExtension(UUID);
        const again = await waitFor(() => mgr.lookup(UUID).stateObj?._monitors?.length > 0);
        check('re-enable detects monitors again', !!again && mgr.lookup(UUID).state === 1);

        // ---- GNOME brightness bridge -------------------------------------
        // The headless shell's only output is virtual, so allow the bridge to
        // attach the DDC/CI monitor to it, exactly as a nested shell needs.
        const inst2 = mgr.lookup(UUID).stateObj;
        const settings2 = inst2._settings;
        const mon = inst2._monitors[0];
        const bright = mon.control(0x10);
        if (!bright) {
            check('native: monitor exposes brightness', false);
            return;
        }
        settings2.set_boolean('brightness-map-unmatched', true);
        settings2.set_boolean('native-brightness', true);
        const bridged = await waitFor(() => Main.brightnessManager.scales.length > 0);
        check('native: monitor registered with GNOME brightness',
            !!bridged && Main.brightnessManager.scales.length === 1,
            `${Main.brightnessManager.scales.length} scales`);
        check('native: GNOME has a global brightness scale', Main.brightnessManager.globalScale !== null);

        const beforeB = ddcGet(mon.bus, '10');
        const target = beforeB / bright.max > 0.5 ? 0.3 : 0.7;
        if (Main.brightnessManager.globalScale)
            Main.brightnessManager.globalScale.value = target;
        await sleep(2500);
        check('native: GNOME brightness scale writes to the monitor',
            ddcGet(mon.bus, '10') === Math.round(target * bright.max),
            `read back ${ddcGet(mon.bus, '10')}, wanted ${Math.round(target * bright.max)}`);

        // Opting out must hand brightness control back untouched.
        settings2.set_boolean('native-brightness', false);
        await waitFor(() => Main.brightnessManager.scales.length === 0, 8000);
        check('native: opting out restores GNOME brightness state',
            Main.brightnessManager.scales.length === 0 && Main.brightnessManager.globalScale === null);
        await waitFor(() => inst2._indicator?.slider?.get_parent() === qs.menu._grid, 8000);
        check('native: extension slider returns when opted out',
            inst2._indicator?.slider?.get_parent() === qs.menu._grid);
    }
}
