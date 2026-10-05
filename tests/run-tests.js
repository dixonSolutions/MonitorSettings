// Unit tests for the ddcutil parsers.  Run: gjs -m tests/run-tests.js
import GLib from 'gi://GLib';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const P = await import(`file://${here}/../monitor-settings@dixonsolutions.github.io/lib/parse.js`);
const fx = n => new TextDecoder().decode(GLib.file_get_contents(`${here}/fixtures/${n}`)[1]);

let failed = 0, passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}\n     ${e.message}`);
    }
}
function eq(a, b, msg = '') {
    const [sa, sb] = [JSON.stringify(a), JSON.stringify(b)];
    if (sa !== sb)
        throw new Error(`${msg} expected ${sb}, got ${sa}`);
}

const vcpinfo = P.parseVcpInfo(fx('vcpinfo.txt'));

test('detect: single real monitor', () => {
    const d = P.parseDetect(fx('detect-benq.txt'));
    eq(d.length, 1);
    eq([d[0].bus, d[0].connector, d[0].mfg, d[0].model, d[0].serial, d[0].valid],
        [10, 'DP-2', 'BNQ', 'BenQ BL2780', 'SERIAL0001', true]);
    eq(d[0].id, 'BNQ:BenQ BL2780:SERIAL0001');
});

test('detect: multiple monitors + invalid display', () => {
    const d = P.parseDetect(fx('detect-multi.txt'));
    eq(d.map(x => [x.bus, x.connector, x.valid]),
        [[10, 'DP-2', true], [12, 'HDMI-A-1', true], [4, 'eDP-1', false]]);
});

test('detect: empty output', () => eq(P.parseDetect('No displays found.\n'), []));

test('capabilities: features and named values', () => {
    const c = P.parseCapabilities(fx('caps-benq.txt'));
    eq(c.mccs, '2.1');
    eq(c.features.size, 28);
    eq(c.features.get(0x60).values.map(v => v.name), ['VGA-1', 'DisplayPort-1', 'HDMI-1']);
    eq(c.features.get(0x10).name, 'Brightness');
});

test('capabilities: unparsed value lists and manufacturer codes', () => {
    const c = P.parseCapabilities(fx('caps-unparsed-values.txt'));
    eq(c.features.get(0x60).values.map(v => v.value), [0x0f, 0x11, 0x1b]);
    eq(c.features.get(0xF0).values.map(v => v.name), ['Off', 'On']);
});

test('vcpinfo: attributes', () => {
    eq([vcpinfo.get(0x10).access, vcpinfo.get(0x10).kind], ['rw', 'continuous']);
    eq([vcpinfo.get(0x04).access, vcpinfo.get(0x04).kind], ['wo', 'wo-nc']);
    eq(vcpinfo.get(0xC0).access, 'ro');
    eq(P.attributesFor(vcpinfo.get(0x14), '3.0').kind, 'nc-complex');
    eq(P.attributesFor(vcpinfo.get(0x14), '2.1').kind, 'nc');
});

test('getvcp: all value types', () => {
    const g = P.parseGetVcp(fx('getvcp-benq.txt') + 'VCP E0 ERR\nVCP 73 T\n');
    eq(g.get(0x10), {type: 'C', value: 50, max: 100});
    eq(g.get(0x14), {type: 'SNC', value: 5, max: 0});
    eq(g.get(0x02).type, 'CNC');
    eq(g.get(0x04).type, 'UNREADABLE');
    eq(g.get(0xE0).type, 'ERR');
    eq(g.get(0x73).type, 'T');
});

test('buildControls: real BenQ produces the expected controls only', () => {
    const controls = P.buildControls({
        caps: P.parseCapabilities(fx('caps-benq.txt')),
        vcpinfo,
        current: P.parseGetVcp(fx('getvcp-benq.txt')),
    });
    eq(controls.map(c => `${P.hex(c.code)}:${c.type}`), [
        '10:range', '12:range', '14:choice', '16:range', '18:range', '1A:range',
        '60:choice', '62:range', '8D:choice', 'CA:choice', 'CC:choice',
        '04:action', '05:action', '08:action',
    ]);
    // Read-only counters, power mode and complex values are excluded
    for (const code of [0x0C, 0xAC, 0xAE, 0xC0, 0xD6, 0x52, 0x02, 0xDF])
        eq(controls.some(c => c.code === code), false, `code ${P.hex(code)}`);
});

test('buildControls: manufacturer features are opt-in', () => {
    const caps = P.parseCapabilities(fx('caps-unparsed-values.txt'));
    const current = P.parseGetVcp('VCP 10 C 30 100\nVCP 60 SNC x1b\nVCP E0 C 3 10\nVCP F0 SNC x01\n');
    const off = P.buildControls({caps, vcpinfo, current});
    eq(off.map(c => c.code), [0x10, 0x60]);
    const on = P.buildControls({caps, vcpinfo, current, includeManufacturer: true});
    eq(on.map(c => `${P.hex(c.code)}:${c.type}:${c.name}`),
        ['10:range:Brightness', '60:choice:Input Source',
            'E0:range:Manufacturer feature 0xE0', 'F0:choice:Manufacturer specific feature']
            .map(s => s.replace('Manufacturer specific feature', 'Manufacturer feature 0xF0')));
});

test('buildControls: current value missing from capability list is still selectable', () => {
    const caps = P.parseCapabilities(fx('caps-benq.txt'));
    const current = P.parseGetVcp('VCP 60 SNC x12\n');
    const c = P.buildControls({caps, vcpinfo, current}).find(x => x.code === 0x60);
    eq(c.value, 0x12);
    eq(c.values.at(-1).value, 0x12);
});

test('buildControls: zero-max continuous values are skipped', () => {
    const caps = P.parseCapabilities(fx('caps-benq.txt'));
    const controls = P.buildControls({caps, vcpinfo, current: P.parseGetVcp('VCP 10 C 0 0\n')});
    eq(controls.some(c => c.code === 0x10), false);
});

print(`\n${passed} passed, ${failed} failed`);
System.exit(failed ? 1 : 0);
