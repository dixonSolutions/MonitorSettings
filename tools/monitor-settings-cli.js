#!/usr/bin/env -S gjs -m
// Command-line front end to the same backend the extension uses.
//   gjs -m tools/monitor-settings-cli.js list
//   gjs -m tools/monitor-settings-cli.js get <monitor#|all> <code>
//   gjs -m tools/monitor-settings-cli.js set <monitor#|all> <code> <value>
import GLib from 'gi://GLib';
import System from 'system';

const libDir = GLib.build_filenamev([GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])), 'monitor-settings@dixonsolutions.github.io', 'lib']);
const {DdcutilBackend} = await import(`file://${libDir}/ddcutil.js`);
const {hex} = await import(`file://${libDir}/parse.js`);

const [cmd = 'list', target = 'all', codeArg, valueArg] = ARGV;
const backend = new DdcutilBackend({log: GLib.getenv('DEBUG') ? print : () => {}});
const {monitors, unsupported} = await backend.scan({includeManufacturer: !!GLib.getenv('MFG')});
const pick = () => target === 'all' ? monitors : [monitors[Number(target) - 1]].filter(Boolean);

if (cmd === 'list') {
    monitors.forEach((m, i) => {
        print(`${i + 1}. ${m.label}  [bus ${m.bus}, MCCS ${m.mccs}, id ${m.id}]`);
        for (const c of m.controls) {
            const desc = c.type === 'range' ? `${c.value}/${c.max}`
                : c.type === 'choice' ? `${c.values.find(v => v.value === c.value)?.name} {${c.values.map(v => v.name).join(', ')}}`
                    : '(action)';
            print(`     ${hex(c.code)} ${c.type.padEnd(6)} ${c.name}: ${desc}`);
        }
    });
    unsupported.forEach(d => print(`-  ${d.model || d.connector || `bus ${d.bus}`}: no DDC/CI (${d.reason})`));
    if (!monitors.length)
        print('No DDC/CI capable monitors found.');
} else if (cmd === 'get' || cmd === 'set') {
    const code = parseInt(codeArg ?? '10', 16);
    let ok = true;
    for (const m of pick()) {
        if (cmd === 'set')
            ok = (await m.write(code, Number(valueArg))) && ok;
        const v = (await m.read([code])).get(code);
        print(`${m.label} ${hex(code)} = ${v?.value ?? 'n/a'}${v?.max ? `/${v.max}` : ''}`);
    }
    if (!ok)
        System.exit(1);
} else {
    printerr('usage: list | get <n|all> <hexcode> | set <n|all> <hexcode> <value>');
    System.exit(2);
}
