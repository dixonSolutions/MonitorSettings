// Hardware check: for every continuous control on every monitor, nudge the
// value by one step, verify the monitor applied it, then restore it.
// Reports which settings the monitor honours and which it silently ignores.
//   gjs -m tests/hardware-test.js
import GLib from 'gi://GLib';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {DdcutilBackend} = await import(`file://${here}/../monitor-settings@dixonsolutions.github.io/lib/ddcutil.js`);
const {hex} = await import(`file://${here}/../monitor-settings@dixonsolutions.github.io/lib/parse.js`);

const backend = new DdcutilBackend();
const {monitors, unsupported} = await backend.scan();
print(`Found ${monitors.length} DDC/CI monitor(s); ${unsupported.length} display(s) without DDC/CI`);
if (!monitors.length)
    System.exit(1);

let ignored = 0;
for (const m of monitors) {
    print(`\n${m.label}`);
    for (const c of m.controls.filter(x => x.type === 'range')) {
        const orig = c.value;
        const target = orig < c.max ? orig + 1 : orig - 1;
        const applied = await m.write(c.code, target);
        const restored = await m.write(c.code, orig);
        if (!applied)
            ignored++;
        print(`  ${hex(c.code)} ${c.name.padEnd(28)} ${applied ? 'ok' : 'IGNORED by monitor'}${restored || !applied ? '' : ' (restore failed!)'}`);
    }
}
print(ignored ? `\n${ignored} setting(s) are accepted but ignored by the monitor (usually locked by a monitor mode such as eco/auto-brightness).` : '\nAll settings applied.');
