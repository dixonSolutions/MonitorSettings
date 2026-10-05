// Pure parsers for ddcutil output. No GNOME Shell imports, so they can be
// unit-tested with plain `gjs -m`.

/** Format a VCP code as two upper-case hex digits, e.g. 16 -> "10". */
export function hex(code) {
    return code.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Parse `ddcutil detect --terse`.
 * Returns [{bus, connector, mfg, model, serial, id, valid, reason}]
 */
export function parseDetect(text) {
    const displays = [];
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        const head = line.match(/^(Display \d+|Invalid display|Phantom display)/);
        if (head) {
            cur = {
                bus: -1, connector: '', mfg: '', model: '', serial: '',
                valid: head[1].startsWith('Display'),
                reason: head[1].startsWith('Display') ? '' : head[1],
            };
            displays.push(cur);
            continue;
        }
        if (!cur)
            continue;
        let m;
        if ((m = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/)))
            cur.bus = Number(m[1]);
        else if ((m = line.match(/DRM[_ ]connector:\s+(\S+)/)))
            cur.connector = m[1].replace(/^card\d+-/, '');
        else if ((m = line.match(/^\s*Monitor:\s+(.*)$/))) {
            const [mfg = '', model = '', ...serial] = m[1].split(':');
            cur.mfg = mfg.trim();
            cur.model = model.trim();
            cur.serial = serial.join(':').trim();
        } else if ((m = line.match(/^\s*Mfg id:\s+(\S+)/)) && !cur.mfg)
            cur.mfg = m[1];
        else if ((m = line.match(/^\s*Model:\s+(.*)$/)) && !cur.model)
            cur.model = m[1].trim();
        else if ((m = line.match(/^\s*Serial number:\s+(.*)$/)) && !cur.serial)
            cur.serial = m[1].trim();
    }
    for (const d of displays) {
        d.id = [d.mfg, d.model, d.serial].join(':');
        if (d.id === '::')
            d.id = `bus-${d.bus}`;
    }
    return displays.filter(d => d.bus >= 0);
}

/**
 * Parse `ddcutil capabilities` (non-terse) output.
 * Returns {mccs, features: Map<code, {code, name, values: [{value, name}]}>}
 */
export function parseCapabilities(text) {
    const features = new Map();
    let mccs = '';
    let cur = null;
    let inValues = false;
    for (const raw of text.split('\n')) {
        let m;
        if ((m = raw.match(/^MCCS version:\s*(\S+)/))) {
            mccs = m[1];
        } else if ((m = raw.match(/^\s*Feature:\s*([0-9A-Fa-f]{2})\s*(?:\((.*)\))?/))) {
            const code = parseInt(m[1], 16);
            cur = {code, name: (m[2] ?? '').trim(), values: []};
            features.set(code, cur);
            inValues = false;
        } else if (cur && /^\s*Values:/.test(raw)) {
            inValues = true;
            // Unparsed form: "Values: 01 0F 11 (interpretation unavailable)"
            const rest = raw.replace(/^\s*Values:\s*/, '').replace(/\(.*\)/, '').trim();
            for (const v of rest.split(/\s+/).filter(s => /^[0-9A-Fa-f]{2}$/.test(s)))
                cur.values.push({value: parseInt(v, 16), name: `0x${v.toLowerCase()}`});
        } else if (cur && inValues && (m = raw.match(/^\s+([0-9A-Fa-f]{2}):\s*(.*)$/))) {
            cur.values.push({value: parseInt(m[1], 16), name: m[2].trim() || `0x${m[1]}`});
        } else if (/^\S/.test(raw)) {
            // Any top-level line ends the feature list section
            if (!/^VCP Features:/.test(raw))
                cur = null;
            inValues = false;
        }
    }
    return {mccs, features};
}

/**
 * Parse `ddcutil vcpinfo --verbose` into Map<code, {name, access, kind, byVersion}>
 * access: 'rw' | 'ro' | 'wo' | 'deprecated'
 * kind: 'continuous' | 'continuous-complex' | 'nc' | 'nc-complex' | 'nc-subrange' | 'table' | 'wo-nc'
 */
export function parseVcpInfo(text) {
    const out = new Map();
    let cur = null;
    for (const raw of text.split('\n')) {
        let m;
        if ((m = raw.match(/^VCP code ([0-9A-Fa-f]{2}):\s*(.*)$/))) {
            cur = {name: m[2].trim(), byVersion: new Map(), access: null, kind: null};
            out.set(parseInt(m[1], 16), cur);
        } else if (cur && (m = raw.match(/^\s*Attributes(?: \(v([\d.]+)\))?:\s*(.*)$/))) {
            const attr = parseAttributes(m[2]);
            if (m[1])
                cur.byVersion.set(m[1], attr);
            if (!cur.access) {
                cur.access = attr.access;
                cur.kind = attr.kind;
            }
        }
    }
    return out;
}

function parseAttributes(s) {
    let access = 'rw';
    if (/Deprecated/i.test(s))
        access = 'deprecated';
    else if (/Read Only/i.test(s))
        access = 'ro';
    else if (/Write Only/i.test(s))
        access = 'wo';

    let kind = 'nc';
    if (/Table/i.test(s))
        kind = 'table';
    else if (/continuous subrange/i.test(s))
        kind = 'nc-subrange';
    else if (/Non-Continuous \(write-only\)/i.test(s))
        kind = 'wo-nc';
    else if (/Non-Continuous \(complex\)/i.test(s))
        kind = 'nc-complex';
    else if (/Non-Continuous/i.test(s))
        kind = 'nc';
    else if (/Continuous \(complex\)/i.test(s))
        kind = 'continuous-complex';
    else if (/Continuous/i.test(s))
        kind = 'continuous';
    return {access, kind};
}

/** Look up vcpinfo attributes for a given monitor MCCS version. */
export function attributesFor(info, mccs) {
    if (!info)
        return null;
    return info.byVersion.get(mccs) ?? {access: info.access, kind: info.kind};
}

/**
 * Parse `ddcutil getvcp ... --terse` output.
 * Returns Map<code, {type: 'C'|'SNC'|'CNC'|'T'|'ERR'|'UNREADABLE', value, max}>
 */
export function parseGetVcp(text) {
    const out = new Map();
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        let m;
        if ((m = line.match(/^VCP ([0-9A-Fa-f]{2}) C (\d+) (\d+)/)))
            out.set(parseInt(m[1], 16), {type: 'C', value: Number(m[2]), max: Number(m[3])});
        else if ((m = line.match(/^VCP ([0-9A-Fa-f]{2}) SNC x([0-9A-Fa-f]+)/)))
            out.set(parseInt(m[1], 16), {type: 'SNC', value: parseInt(m[2], 16), max: 0});
        else if ((m = line.match(/^VCP ([0-9A-Fa-f]{2}) CNC x([0-9a-fA-F]+) x([0-9a-fA-F]+) x([0-9a-fA-F]+) x([0-9a-fA-F]+)/))) {
            const [mh, ml, sh, sl] = [m[2], m[3], m[4], m[5]].map(h => parseInt(h, 16));
            out.set(parseInt(m[1], 16), {type: 'CNC', value: (sh << 8) | sl, max: (mh << 8) | ml});
        } else if ((m = line.match(/^VCP ([0-9A-Fa-f]{2}) T/)))
            out.set(parseInt(m[1], 16), {type: 'T', value: 0, max: 0});
        else if ((m = line.match(/^VCP ([0-9A-Fa-f]{2}) ERR/)))
            out.set(parseInt(m[1], 16), {type: 'ERR', value: 0, max: 0});
        else if ((m = line.match(/^Feature ([0-9A-Fa-f]{2}) .*not readable/)))
            out.set(parseInt(m[1], 16), {type: 'UNREADABLE', value: 0, max: 0});
    }
    return out;
}

// Codes that are protocol plumbing or would make the monitor go dark /
// unresponsive. They are never offered as user controls.
export const NEVER_SHOW = new Set([
    0x02, // New control value
    0x03, // Soft controls
    0x52, // Active control
    0xC6, // Application enable key
    0xD6, // Power mode (can switch the display off)
    0xDF, // VCP version
]);

// Codes that are useful and safe to offer as one-click actions.
export const ACTION_CODES = new Set([0x01, 0x04, 0x05, 0x06, 0x08, 0x0A]);

/**
 * Decide which controls a monitor offers from its capabilities, vcpinfo,
 * and current values. Nothing is assumed about specific monitors.
 *
 * Returns [{code, name, type: 'range'|'choice'|'action', value, max, values, manufacturer}]
 */
export function buildControls({caps, vcpinfo, current, includeManufacturer = false}) {
    const controls = [];
    for (const [code, feat] of caps.features) {
        if (NEVER_SHOW.has(code))
            continue;
        const info = vcpinfo.get(code);
        const manufacturer = code >= 0xE0;
        if (manufacturer && !includeManufacturer)
            continue;
        const attr = attributesFor(info, caps.mccs);
        const name = feat.name && !/^Manufacturer specific/i.test(feat.name)
            ? feat.name
            : info?.name && !/^Manufacturer Specific/i.test(info.name)
                ? info.name
                : `Manufacturer feature 0x${hex(code)}`;
        const cur = current.get(code);

        if (attr && (attr.access === 'ro' || attr.access === 'deprecated'))
            continue;

        if (attr?.access === 'wo') {
            if (attr.kind === 'wo-nc' && ACTION_CODES.has(code))
                controls.push({code, name, type: 'action', value: 0, max: 0, values: [], manufacturer});
            continue;
        }

        if (!cur)
            continue;

        if (cur.type === 'C' && cur.max > 0 &&
            (!attr || attr.kind === 'continuous')) {
            controls.push({code, name, type: 'range', value: cur.value, max: cur.max, values: [], manufacturer});
        } else if ((cur.type === 'SNC' || cur.type === 'CNC') && feat.values.length > 0 &&
                   (!attr || attr.kind === 'nc' || attr.kind === 'nc-complex' || attr.kind === 'nc-subrange')) {
            const value = cur.type === 'CNC' ? cur.value & 0xFF : cur.value;
            const values = [...feat.values];
            if (!values.some(v => v.value === value))
                values.push({value, name: `0x${hex(value).toLowerCase()}`});
            controls.push({code, name, type: 'choice', value, max: 0, values, manufacturer});
        }
    }
    // Brightness and contrast first, then by code.
    const rank = c => (c.code === 0x10 ? 0 : c.code === 0x12 ? 1 : c.type === 'action' ? 3 : 2);
    controls.sort((a, b) => rank(a) - rank(b) || a.code - b.code);
    return controls;
}

/** printf-style %s/%d substitution that works in both the shell and prefs processes. */
export function fmt(str, ...args) {
    let i = 0;
    return str.replace(/%[sd]/g, () => String(args[i++]));
}
