'use strict';

const { expect } = require('chai');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parsers = require('./lib/parsers.json');

describe('parser definitions', () => {
    it('should define temperature fan activity parser', () => {
        expect(parsers.temperature).to.have.property('fan_activity');
        expect(parsers.temperature.fan_activity).to.deep.equal({
            command:
                'test -r /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input && cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || echo "0"',
            regexp: '(\\d+)',
            post: '',
            role: 'value.speed',
        });
    });

    it('should capture fan RPM values with the configured regexp', () => {
        const fanRegexp = new RegExp(parsers.temperature.fan_activity.regexp);
        const match = fanRegexp.exec('3200\n');
        expect(match).to.exist;
        expect(match?.[1]).to.equal('3200');
    });

    it('should capture fallback fan value when fan hardware is unavailable', () => {
        const fanRegexp = new RegExp(parsers.temperature.fan_activity.regexp);
        const match = fanRegexp.exec('0\n');
        expect(match).to.exist;
        expect(match?.[1]).to.equal('0');
    });
});

// outputs as printed by smartmontools 7.3
const smartctlSata = `smartctl 7.3 2022-02-28 r5338 [aarch64-linux-6.6.51+rpt-rpi-2712] (local build)
Copyright (C) 2002-22, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF READ SMART DATA SECTION ===
SMART Attributes Data Structure revision number: 1
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  9 Power_On_Hours          0x0032   099   099   000    Old_age   Always       -       1234
194 Temperature_Celsius     0x0022   035   048   000    Old_age   Always       -       35 (Min/Max 20/48)
199 UDMA_CRC_Error_Count    0x003e   200   200   000    Old_age   Always       -       0
`;
const smartctlNvme = `smartctl 7.3 2022-02-28 r5338 [aarch64-linux-6.6.51+rpt-rpi-2712] (local build)
Copyright (C) 2002-22, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF SMART DATA SECTION ===
SMART/Health Information (NVMe Log 0x02)
Critical Warning:                   0x00
Temperature:                        41 Celsius
Available Spare:                    100%
Temperature Sensor 1:               44 Celsius
`;
const smartctlNoSmart = `smartctl 7.3 2022-02-28 r5338 [aarch64-linux-6.6.51+rpt-rpi-2712] (local build)
/dev/sda: Unknown USB bridge [0x152d:0x0578 (0x209)]
Please specify device type with the -d option.
`;

describe('disk temperature parser', () => {
    const diskTemp = parsers.temperature.disk_temp;
    /** @type {string} */
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi2-disk-temp-'));
        fs.mkdirSync(path.join(dir, 'bin'));
        fs.mkdirSync(path.join(dir, 'dev'));
        // fake sudo: prints the smartctl output stored for the device, fails without one
        const sudo = path.join(dir, 'bin', 'sudo');
        fs.writeFileSync(sudo, '#!/bin/sh\ncat "$(dirname "$0")/../smart/$(basename "$4")" 2>/dev/null || exit 4\n');
        fs.chmodSync(sudo, 0o755);
        fs.mkdirSync(path.join(dir, 'smart'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Creates fake devices and runs the parser command on them, like main.js does.
     *
     * @param drives {Record<string, string|null>} device name -> smartctl output, null if sudo or smartctl fails
     */
    function readDiskTemp(drives) {
        for (const [name, output] of Object.entries(drives)) {
            fs.writeFileSync(path.join(dir, 'dev', name), '');
            if (output !== null) {
                fs.writeFileSync(path.join(dir, 'smart', name), output);
            }
        }
        const command = diskTemp.command.replaceAll('/dev/', `${dir}/dev/`);
        const stdout = execSync(command, { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` } }).toString();
        return new RegExp(diskTemp.regexp).exec(stdout)?.[1];
    }

    it('reads the temperature of a SATA drive', () => {
        expect(readDiskTemp({ sda: smartctlSata })).to.equal('35');
    });

    it('reads the airflow temperature if the drive has no attribute 194', () => {
        const output = smartctlSata.replace(
            /^194 .*$/m,
            '190 Airflow_Temperature_Cel 0x0032   067   052   045    Old_age   Always       -       33',
        );
        expect(readDiskTemp({ sda: output })).to.equal('33');
    });

    it('reads the temperature of an NVMe drive', () => {
        expect(readDiskTemp({ nvme0: smartctlNvme })).to.equal('41');
    });

    it('prefers the NVMe drive', () => {
        expect(readDiskTemp({ nvme0: smartctlNvme, sda: smartctlSata })).to.equal('41');
    });

    it('skips drives without temperature', () => {
        expect(readDiskTemp({ sda: smartctlNoSmart, sdb: smartctlSata })).to.equal('35');
    });

    it('skips drives smartctl may not read', () => {
        expect(readDiskTemp({ nvme0: null, sda: smartctlSata })).to.equal('35');
    });

    it('yields no value without drive or sudo rule, without failing', () => {
        expect(readDiskTemp({})).to.equal(undefined);
        expect(readDiskTemp({ sda: null })).to.equal(undefined);
        expect(diskTemp.optional).to.equal(true);
    });
});
