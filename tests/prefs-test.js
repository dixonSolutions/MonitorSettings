// Loads prefs.js the way the Extensions app does and checks it builds and
// detects monitors. Needs a display (run-shell-test.sh with MS_PREFS_TEST=1).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const dir = GLib.getenv('MS_EXT_DIR') ?? `${here}/../monitor-settings@dixonsolutions.github.io`;
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dir}/metadata.json`)[1]));
metadata.path = dir;
metadata.dir = Gio.File.new_for_path(dir);

const {default: Prefs} = await import(`file://${dir}/prefs.js`);
Adw.init();
let failed = false;
const check = (name, ok, detail = '') => {
    failed ||= !ok;
    print(`${ok ? 'ok  ' : 'FAIL'} prefs: ${name}${detail ? ` — ${detail}` : ''}`);
};
const win = new Adw.PreferencesWindow();
try {
    const prefs = new Prefs(metadata);
    // The Extensions app normally registers the instance for gettext lookup.
    const {ExtensionPreferences} = await import('resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
    ExtensionPreferences.lookupByUUID = uuid => (uuid === metadata.uuid ? prefs : null);
    prefs.fillPreferencesWindow(win);
    check('window filled without errors', true);
} catch (e) {
    check('window filled without errors', false, `${e}\n${e.stack}`);
}
win.present();
const rowTitles = () => {
    const titles = [];
    const walk = w => {
        if (w instanceof Adw.PreferencesRow)
            titles.push(w.title);
        for (let c = w.get_first_child(); c; c = c.get_next_sibling())
            walk(c);
    };
    walk(win);
    return titles;
};
const started = Date.now();
await new Promise(done => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    const titles = rowTitles();
    if (titles.includes('Detecting monitors…') && Date.now() - started < 25000)
        return GLib.SOURCE_CONTINUE;
    print(`     prefs: scan took ${Date.now() - started} ms`);
    check('monitor listed', titles.some(t => / \([A-Za-z]+-[\w-]+\)$/.test(t)), titles.find(t => / \([A-Za-z]+-[\w-]+\)$/.test(t)));
    check('feature toggles listed', titles.includes('Brightness'), titles.join(' | '));
    check('behaviour settings present', titles.includes('Keyboard step (%)'));
    win.destroy();
    done();
    return GLib.SOURCE_REMOVE;
}));
if (failed)
    imports.system.exit(1);
